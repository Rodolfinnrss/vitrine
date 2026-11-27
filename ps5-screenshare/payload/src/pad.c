/* PS5 Screen Share - virtual controller driven by the viewer's touches.
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * Copyright (C) 2026 PBS-Payload contributors (the virtual-pad export
 *                    sequence below follows their controller backend)
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * On the console, input goes to libScePad's virtual pad. The viewer that
 * holds control sends its state every 50 ms (the protocol needs at least one
 * update per 100 ms). The pad goes neutral after 250 ms of silence and is
 * released after 2 s, when the owner disconnects, or on PADRELEASE.
 */
#include "pad.h"

#include "log.h"
#include "platform.h"

#include <errno.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define RELEASE_MS 250
#define IDLE_MS 2000
#define TICK_US 4000

static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_t g_thread;
static int g_started, g_running, g_healthy;
static const void *g_owner;
static pad_state g_state;
static const pad_state g_neutral = {0, 128, 128, 128, 128, 0, 0};
static int g_pending, g_neutral_sent, g_have_seq;
static uint32_t g_last_seq;
static uint64_t g_last_rx, g_writes;
static uint32_t g_last_buttons;

static uint64_t now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint64_t)t.tv_sec * 1000u + (uint64_t)t.tv_nsec / 1000000u;
}

/* ---------------------------------------------------------- backend --- */

#ifdef PS5SS_HOST
/* Host build: no console. PS5SS_MOCK_PAD=0 simulates a console without a
 * virtual controller. Writes are only counted (tests read them via /status). */
static int backend_init(void) {
  const char *e = getenv("PS5SS_MOCK_PAD");
  return e && !strcmp(e, "0") ? -1 : 0;
}
static int backend_write(const pad_state *s) {
  (void)s;
  return 0;
}
static void backend_destroy(void) {}
#else
#include <ps5/kernel.h>

int sceKernelLoadStartModule(const char *, size_t, const void *, uint32_t, void *, uint32_t *);

static struct {
  int (*init)(void);
  int (*privilege)(int);
  int (*add)(const void *, void *);
  int (*insert)(int, const void *);
  int (*remove)(int);
  uint32_t device;
  int privileged, owned;
} api;

static void *export(uint32_t module, const char *name) {
  return (void *)kernel_dynlib_dlsym(getpid(), module, name);
}

static int backend_init(void) {
  uint32_t module = 0;
  if (kernel_dynlib_handle(getpid(), "libScePad.sprx", &module)) {
    int rc = sceKernelLoadStartModule("/system/common/lib/libScePad.sprx", 0, NULL, 0, NULL, NULL);
    LOG("pad: load libScePad -> 0x%x", rc);
    /* Use the handle LoadStartModule returns. Looking the module up by name
     * again can fail right after a successful load on newer firmware. */
    if (rc <= 0) return -1;
    module = (uint32_t)rc;
  }
  api.init = export(module, "scePadInit");
  api.privilege = export(module, "scePadSetProcessPrivilege");
  api.add = export(module, "scePadVirtualDeviceAddDevice");
  api.insert = export(module, "scePadVirtualDeviceInsertData");
  api.remove = export(module, "scePadVirtualDeviceDeleteDevice");
  if (!api.init || !api.privilege || !api.add || !api.insert || !api.remove) {
    LOG("pad: virtual controller exports missing");
    return -1;
  }
  int rc = api.init();
  if (rc) {
    LOG("pad: scePadInit -> 0x%x", rc);
    return -1;
  }
  rc = api.privilege(1);
  LOG("pad: SetProcessPrivilege(1) -> 0x%x", rc);
  if (rc) return -1;
  api.privileged = 1;
  /* Profile byte 1 at +4, as PBS-Payload uses. The library builds the native
   * record for the running firmware itself. */
  unsigned char request[0x40] = {0}, output[16] = {0};
  request[4] = 1;
  memset(output, 0xff, 4);
  rc = api.add(request, output);
  LOG("pad: VirtualDeviceAddDevice -> 0x%x", rc);
  if (rc) return -1;
  memcpy(&api.device, output, 4);
  if (api.device == UINT32_MAX) return -1;
  api.owned = 1;
  return 0;
}

static int backend_write(const pad_state *s) {
  /* InsertData layout: buttons u32, sticks u8[4], triggers u8[2], then a
   * zeroed motion/touch area and orientation w = 1.0 at +0x18. */
  unsigned char data[0x80] = {0};
  memcpy(data, &s->buttons, 4);
  data[4] = s->lx;
  data[5] = s->ly;
  data[6] = s->rx;
  data[7] = s->ry;
  data[8] = s->l2;
  data[9] = s->r2;
  float w = 1.0f;
  memcpy(data + 0x18, &w, 4);
  return api.insert((int)api.device, data);
}

static void backend_destroy(void) {
  if (api.owned) {
    int rc = api.remove((int)api.device);
    LOG("pad: VirtualDeviceDeleteDevice -> 0x%x", rc);
    if (!rc) api.owned = 0;
  }
  if (api.privileged) {
    LOG("pad: SetProcessPrivilege(0) -> 0x%x", api.privilege(0));
    api.privileged = 0;
  }
}
#endif

/* ----------------------------------------------------------- driver --- */

/* Called with g_lock held. */
static void apply_state_locked(void) {
  if (!g_pending || !g_healthy) {
    g_pending = 0;
    return;
  }
  pad_state s = g_state;
  g_pending = 0;
  if (backend_write(&s)) {
    LOG("pad: input write failed; virtual controller disabled until restart");
    g_healthy = 0;
    g_owner = NULL;
    return;
  }
  g_writes++;
  g_last_buttons = s.buttons;
}

static void *pad_main(void *unused) {
  (void)unused;
  for (;;) {
    pthread_mutex_lock(&g_lock);
    if (!g_running) {
      pthread_mutex_unlock(&g_lock);
      break;
    }
    if (g_owner) {
      uint64_t age = now_ms() - g_last_rx;
      if (age >= IDLE_MS) {
        LOG("pad: owner silent for %d ms; released", IDLE_MS);
        g_owner = NULL;
        g_have_seq = 0;
        g_state = g_neutral;
        g_pending = 1;
      } else if (age >= RELEASE_MS && !g_neutral_sent) {
        g_state = g_neutral;
        g_pending = 1;
        g_neutral_sent = 1;
      }
    }
    apply_state_locked();
    pthread_mutex_unlock(&g_lock);
    usleep(TICK_US);
  }
  return NULL;
}

int pad_init(int enabled) {
  if (!enabled) {
    LOG("pad: disabled by configuration");
    return -1;
  }
  if (backend_init()) {
    LOG("pad: virtual controller unavailable on this console");
    backend_destroy(); /* undo any partial setup (privilege, device) */
    return -1;
  }
  pthread_mutex_lock(&g_lock);
  g_healthy = 1;
  g_running = 1;
  g_state = g_neutral;
  g_pending = 1;
  pthread_mutex_unlock(&g_lock);
  if (platform_thread(&g_thread, pad_main, NULL, 0)) {
    LOG("pad: cannot start the input thread");
    pthread_mutex_lock(&g_lock);
    g_healthy = 0;
    g_running = 0;
    pthread_mutex_unlock(&g_lock);
    backend_destroy();
    return -1;
  }
  g_started = 1;
  LOG("pad: virtual controller ready");
  return 0;
}

void pad_shutdown(void) {
  pthread_mutex_lock(&g_lock);
  g_running = 0;
  pthread_mutex_unlock(&g_lock);
  if (g_started) {
    pthread_join(g_thread, NULL);
    g_started = 0;
  }
  pthread_mutex_lock(&g_lock);
  if (g_healthy) {
    g_state = g_neutral;
    g_pending = 1;
    apply_state_locked();
    backend_destroy();
  }
  g_healthy = 0;
  g_owner = NULL;
  pthread_mutex_unlock(&g_lock);
}

int pad_submit(const void *owner, uint32_t seq, const pad_state *state) {
  int result;
  pthread_mutex_lock(&g_lock);
  if (!g_healthy) {
    result = PAD_UNAVAILABLE;
  } else {
    if (!g_owner) {
      g_owner = owner;
      g_have_seq = 0;
      LOG("pad: controller taken by a viewer");
    }
    if (g_owner != owner) {
      result = PAD_BUSY;
    } else {
      /* Sequence numbers wrap; a late or repeated packet must not move the
       * pad backwards. */
      if (!g_have_seq || (int32_t)(seq - g_last_seq) > 0) {
        g_have_seq = 1;
        g_last_seq = seq;
        g_state = *state;
        g_pending = 1;
      }
      g_neutral_sent = 0;
      g_last_rx = now_ms();
      result = PAD_YOURS;
    }
  }
  pthread_mutex_unlock(&g_lock);
  return result;
}

int pad_state_for(const void *owner) {
  int result;
  pthread_mutex_lock(&g_lock);
  if (!g_healthy) result = PAD_UNAVAILABLE;
  else if (!g_owner) result = PAD_FREE;
  else if (g_owner == owner) result = PAD_YOURS;
  else result = PAD_BUSY;
  pthread_mutex_unlock(&g_lock);
  return result;
}

void pad_release(const void *owner) {
  pthread_mutex_lock(&g_lock);
  if (g_owner && g_owner == owner) {
    g_owner = NULL;
    g_have_seq = 0;
    g_state = g_neutral;
    g_pending = 1;
    g_neutral_sent = 1;
    LOG("pad: controller released by its viewer");
  }
  pthread_mutex_unlock(&g_lock);
}

void pad_get_info(pad_info *out) {
  if (!out) return;
  pthread_mutex_lock(&g_lock);
  out->available = g_healthy;
  out->owned = g_owner != NULL;
  out->writes = g_writes;
  out->buttons = g_last_buttons;
  pthread_mutex_unlock(&g_lock);
}

/* Parses seq,buttons,lx,ly,rx,ry,l2,r2. Every field is decimal and checked. */
int pad_parse(const char *text, uint32_t *seq, pad_state *state) {
  uint32_t v[8];
  if (!text || !seq || !state) return -1;
  for (unsigned i = 0; i < 8; i++) {
    if (*text < '0' || *text > '9') return -1;
    errno = 0;
    char *end = NULL;
    unsigned long long n = strtoull(text, &end, 10);
    if (errno || n > (i < 2 ? UINT32_MAX : 255u)) return -1;
    v[i] = (uint32_t)n;
    if (i < 7) {
      if (*end != ',') return -1;
      text = end + 1;
    } else if (*end) {
      return -1;
    }
  }
  if (v[1] & ~PAD_VALID_BITS) return -1;
  *seq = v[0];
  state->buttons = v[1];
  state->lx = (uint8_t)v[2];
  state->ly = (uint8_t)v[3];
  state->rx = (uint8_t)v[4];
  state->ry = (uint8_t)v[5];
  state->l2 = (uint8_t)v[6];
  state->r2 = (uint8_t)v[7];
  return 0;
}
