/* PS5 Screen Share - libSceAvcap2 H.264 capture (console build).
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * Copyright (C) 2026 heydemoura (ps5-web-stream, from which the capture
 *                    sequence below is adapted)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "avcap.h"

#include "log.h"
#include "platform.h"

#include <dlfcn.h>
#include <limits.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define AVCAP_INVALID ((int)0x81950001)
#define AVCAP_EMPTY ((int)0x81950002)
#define AVCAP_OVERRUN ((int)0x81950004)
#define AVCAP_NO_RESOURCE ((int)0x81950008)
#define KEYFRAME_INTERVAL_US UINT64_C(2000000)
#define REQUEST_MAX 0x400

static void *g_lib, *g_ipmi, *g_kernel, *g_video;
static int g_initialized, g_err;
static int (*p_Initialize)(void), (*p_Terminate)(void);
static int (*p_OpenVideo)(void **, void *, int);
static int (*p_Start)(void *), (*p_Stop)(void *), (*p_Close)(void *);
static int (*p_ReadVideo)(void *, void *, uint64_t, void *, int);
static int (*p_GetVideoOutMode)(int *);
static int (*p_GetHeaders)(void *, void *);
static int (*p_RequestKeyFrame)(void *);
static uint64_t (*p_ReadTsc)(void);
static uint64_t g_tsc_frequency, g_source_origin, g_target_origin;
static int g_clock_set;

static void *g_ra_lib;
static int (*p_RaSet)(int, void (*)(int, int, void *), void *);
static int (*p_RaCheck)(int, const char *);
static int (*p_RaState)(int, const char *, void *, int);
static int (*p_RaClear)(int);
static int g_ra_registered_small, g_ra_registered_large, g_ra_owned;
static atomic_int g_ra_event, g_ra_resource, g_ra_wait_running;

static uint8_t g_headers[264];
static size_t g_headers_len;
static uint64_t g_keyframe_clock_us;
static int g_have_keyframe_clock;

static avcap_options g_opt = {REQ_AUTO, 0xb4, 0xb6};
static char g_desc[96] = "not loaded";

void avcap_set_options(const avcap_options *o) {
  if (!o) return;
  g_opt = *o;
  if (g_opt.resource_1080 <= 0) g_opt.resource_1080 = 0xb4;
  if (g_opt.resource_4k <= 0) g_opt.resource_4k = 0xb6;
}

int avcap_last_error(void) { return g_err; }
int avcap_resource_id(void) { return g_video ? atomic_load(&g_ra_resource) : -1; }
const char *avcap_profile_desc(void) { return g_desc; }

/* ------------------------------------------------ ResourceArbitrator --- */

static void resource_callback(int id, int event, void *info) {
  if (id != atomic_load(&g_ra_resource) || event != 1 || !info) return;
  /* Completion: success byte at +0, state count at +4, up to five 32-byte
   * state names from +0x18. Match resource and state so a late RUNNING
   * completion cannot finish a STOP wait. */
  const uint8_t *result = info;
  uint32_t count;
  memcpy(&count, result + 4, sizeof(count));
  if (count > 5) return;
  const char *expected = atomic_load(&g_ra_wait_running) ? "RUNNING" : "STOP";
  for (uint32_t i = 0; i < count; ++i) {
    if (!strncmp((const char *)result + 0x18 + i * 0x20, expected, 0x20)) {
      atomic_store(&g_ra_event, *result == 1 ? 1 : -1);
      return;
    }
  }
}

static int resource_wait(void) {
  for (unsigned i = 0; i < 3000; ++i) { /* up to 15 s (4K renegotiation) */
    int event = atomic_load(&g_ra_event);
    if (event) return event > 0 ? 0 : AVCAP_NO_RESOURCE;
    usleep(5000);
  }
  return AVCAP_NO_RESOURCE;
}

static void resource_release(void) {
  if (!g_ra_owned) return;
  atomic_store(&g_ra_wait_running, 0);
  atomic_store(&g_ra_event, 0);
  int resource = atomic_load(&g_ra_resource);
  int r = p_RaState(resource, "STOP", NULL, getpid());
  if (r >= 0) r = resource_wait();
  LOG("avcap: ResourceArbitrator 0x%x STOP -> 0x%x", resource, r);
  if (r >= 0) g_ra_owned = 0;
}

static int resource_acquire(int resource) {
  if (g_ra_owned) {
    resource_release();
    if (g_ra_owned) return AVCAP_NO_RESOURCE;
  }
  if (!g_ra_lib) {
    g_ra_lib = dlopen("libSceResourceArbitrator.sprx", RTLD_NOW | RTLD_GLOBAL);
    if (!g_ra_lib) { LOG("avcap: ResourceArbitrator load failed: %s", dlerror()); return -1; }
    p_RaSet = dlsym(g_ra_lib, "sceResourceArbitratorSetCallback");
    p_RaCheck = dlsym(g_ra_lib, "sceResourceArbitratorIsExecutable");
    p_RaState = dlsym(g_ra_lib, "sceResourceArbitratorChangeState");
    p_RaClear = dlsym(g_ra_lib, "sceResourceArbitratorClearCallback");
  }
  if (!p_RaSet || !p_RaCheck || !p_RaState || !p_RaClear) return -1;
  atomic_store(&g_ra_resource, resource);
  int *registered = resource == g_opt.resource_4k ? &g_ra_registered_large
                                                  : &g_ra_registered_small;
  int r;
  /* Registrations live for the whole process: repeated clear/register cycles
   * can block inside the firmware. */
  if (!*registered) {
    r = p_RaSet(resource, resource_callback, NULL);
    LOG("avcap: ResourceArbitrator SetCallback(0x%x) -> 0x%x", resource, r);
    if (r < 0) return r;
    *registered = 1;
  }
  r = p_RaCheck(resource, "RUNNING");
  if (r != 1) {
    LOG("avcap: ResourceArbitrator IsExecutable(0x%x) -> 0x%x", resource, r);
    return r < 0 ? r : AVCAP_NO_RESOURCE;
  }
  atomic_store(&g_ra_wait_running, 1);
  atomic_store(&g_ra_event, 0);
  r = p_RaState(resource, "RUNNING", NULL, getpid());
  if (r < 0) return r;
  g_ra_owned = 1;
  r = resource_wait();
  if (r < 0) { resource_release(); return r; }
  LOG("avcap: ResourceArbitrator 0x%x RUNNING", resource);
  return 0;
}

/* ------------------------------------------------------------- Avcap2 --- */

static void *resolve(const char *name) {
  void *p = dlsym(g_lib, name);
  if (!p) LOG("avcap: missing %s", name);
  return p;
}

int avcap_load(void) {
  if (g_lib) return 0;
  g_ipmi = dlopen("libSceIpmi.sprx", RTLD_NOW | RTLD_GLOBAL);
  if (!g_ipmi) { LOG("avcap: Ipmi load failed: %s", dlerror()); return g_err = -1; }
  g_lib = dlopen("libSceAvcap2.sprx", RTLD_NOW | RTLD_GLOBAL);
  if (!g_lib) { LOG("avcap: libSceAvcap2 load failed: %s", dlerror()); return g_err = -1; }
  p_Initialize = resolve("sceAvcap2Initialize");
  p_Terminate = resolve("sceAvcap2Terminate");
  p_OpenVideo = resolve("sceAvcap2OpenVideo");
  p_Start = resolve("sceAvcap2Start");
  p_Stop = resolve("sceAvcap2Stop");
  p_Close = resolve("sceAvcap2Close");
  p_ReadVideo = resolve("sceAvcap2ReadVideo");
  p_GetVideoOutMode = resolve("sceAvcap2GetVideoOutMode");
  p_GetHeaders = resolve("sceAvcap2GetNonVclNalUnitStream");
  p_RequestKeyFrame = resolve("sceAvcap2RequestKeyFrame");
  g_kernel = dlopen("libkernel.sprx", RTLD_NOW | RTLD_GLOBAL);
  p_ReadTsc = g_kernel ? dlsym(g_kernel, "sceKernelReadTsc") : NULL;
  uint64_t (*frequency)(void) = g_kernel ? dlsym(g_kernel, "sceKernelGetTscFrequency") : NULL;
  g_tsc_frequency = frequency ? frequency() : 0;
  if (!p_Initialize || !p_Terminate || !p_OpenVideo || !p_Start || !p_Stop ||
      !p_Close || !p_ReadVideo || !p_GetVideoOutMode || !p_GetHeaders ||
      !p_RequestKeyFrame || !p_ReadTsc || !g_tsc_frequency) {
    dlclose(g_lib);
    g_lib = NULL;
    return g_err = -1;
  }
  return g_err = 0;
}

int avcap_init(void) {
  if (g_initialized) return 0;
  if (!g_lib && avcap_load() < 0) return g_err;
  int r = p_Initialize();
  LOG("avcap: Initialize -> 0x%x", r);
  if (r >= 0) g_initialized = 1;
  g_err = r;
  return r < 0 ? r : 0;
}

static void hexdump_request(const uint8_t *p, size_t n) {
  char line[128];
  for (size_t off = 0; off < n; off += 32) {
    size_t len = 0;
    int nonzero = 0;
    for (size_t i = off; i < off + 32 && i < n; i++) nonzero |= p[i];
    if (!nonzero) continue;
    len += (size_t)snprintf(line + len, sizeof(line) - len, "%03zx:", off);
    for (size_t i = off; i < off + 32 && i < n; i++)
      len += (size_t)snprintf(line + len, sizeof(line) - len, "%s%02x", (i % 8) ? "" : " ", p[i]);
    LOG("avcap:   %s", line);
  }
}

int avcap_open(const avcap_config *cfg) {
  if (!cfg || !g_initialized || g_video || (cfg->fps != 30 && cfg->fps != 60) ||
      cfg->kbps <= 0 || (unsigned)cfg->kbps > UINT32_MAX / 1000u)
    return g_err = AVCAP_INVALID;

  uint32_t fw = platform_fw_version();
  fw_match match;
  const fw_profile *prof = fw_find_profile(fw, &match);
  if (!prof) return g_err = AVCAP_INVALID;
  req_variant variant = g_opt.variant == REQ_AUTO ? fw_auto_variant(fw, prof, match) : g_opt.variant;
  if (variant == REQ_PWS && prof->request_size != 0x2e0) variant = REQ_NATIVE;
  static const char *match_name[] = {"exact", "family", "guess"};
  snprintf(g_desc, sizeof(g_desc), "fw %x.%02x %s (perfil %x.%02x), pedido %s 0x%x",
           (fw >> 24) & 0xff, (fw >> 16) & 0xff, match_name[match],
           (prof->fw >> 24) & 0xff, (prof->fw >> 16) & 0xff,
           fw_variant_name(variant), prof->request_size);

  int code = fw_resolution_code(fw, cfg->height);
  if (code < 0) {
    LOG("avcap: %dp is not available on this firmware", cfg->height);
    return g_err = AVCAP_INVALID;
  }
  int mode = -1;
  int r = p_GetVideoOutMode(&mode);
  LOG("avcap: GetVideoOutMode -> 0x%x mode=0x%x", r, mode);
  if (r < 0) return g_err = r;

  /* 1440p/4K need the larger capture tap (RemotePlay's scaninType=3). */
  int resource = cfg->height >= 1440 ? g_opt.resource_4k : g_opt.resource_1080;
  r = resource_acquire(resource);
  if (r < 0) return g_err = r;

  uint8_t params[REQUEST_MAX];
  req_params rp = {cfg->width, cfg->height, cfg->fps, cfg->kbps, code, resource, mode};
  int size = fw_build_request(params, sizeof(params), prof, variant, &rp);
  if (size < 0) { resource_release(); return g_err = AVCAP_INVALID; }
  LOG("avcap: %s", g_desc);
  hexdump_request(params, (size_t)size);

  void *handle = NULL;
  r = p_OpenVideo(&handle, params, 0);
  LOG("avcap: OpenVideo %dx%d@%d %d kbps mode=0x%x res=0x%x -> 0x%x", cfg->width,
      cfg->height, cfg->fps, cfg->kbps, mode, resource, r);
  if (r < 0) { resource_release(); return g_err = r; }
  if (!handle) { resource_release(); return g_err = -1; }

  /* SPS and PPS: 64-bit lengths at +0x10 / +0x98, data (no start codes) at
   * +0x18 / +0xa0. */
  uint8_t headers[0x1a8] = {0};
  uint32_t hsize = sizeof(headers);
  memcpy(headers, &hsize, sizeof(hsize));
  r = p_GetHeaders(handle, headers);
  g_headers_len = 0;
  if (r >= 0) {
    const size_t offsets[] = {0x10, 0x98};
    for (unsigned i = 0; i < 2; ++i) {
      uint64_t len;
      memcpy(&len, headers + offsets[i], sizeof(len));
      if (!len || len > 128 || (headers[offsets[i] + 8] & 31) != 7 + i) {
        r = AVCAP_INVALID;
        break;
      }
      memcpy(g_headers + g_headers_len, "\0\0\0\1", 4);
      g_headers_len += 4;
      memcpy(g_headers + g_headers_len, headers + offsets[i] + 8, (size_t)len);
      g_headers_len += (size_t)len;
    }
  }
  LOG("avcap: NonVcl headers -> 0x%x (%zu bytes)", r, g_headers_len);
  if (r < 0) {
    LOG("avcap: Close after header failure -> 0x%x", p_Close(handle));
    resource_release();
    g_headers_len = 0;
    return g_err = r;
  }
  r = p_Start(handle);
  LOG("avcap: Start -> 0x%x", r);
  if (r < 0) {
    LOG("avcap: Close after start failure -> 0x%x", p_Close(handle));
    resource_release();
    return g_err = r;
  }
  g_video = handle;
  return g_err = 0;
}

static int video_timestamp(uint64_t ticks, uint64_t *us) {
  __int128 mapped = (__int128)g_target_origin + (__int128)ticks - g_source_origin;
  if (mapped < 0 || mapped > (__int128)UINT64_MAX) return -1;
  __uint128_t converted = (__uint128_t)mapped * 1000000u / 240000u;
  if (converted > UINT64_MAX) return -1;
  *us = (uint64_t)converted;
  return 0;
}

static int has_idr(const uint8_t *p, size_t n) {
  for (size_t i = 0; i + 3 < n; ++i)
    if (p[i] == 0 && p[i + 1] == 0 && p[i + 2] == 1 && (p[i + 3] & 31) == 5) return 1;
  return 0;
}

int avcap_read_video(uint8_t *buf, size_t size, avcap_frame *fr) {
  if (!g_video || !buf || !size || !fr) return g_err = AVCAP_INVALID;
  uint8_t info[0x80] = {0};
  int r = p_ReadVideo(g_video, buf, size - sizeof(g_headers), info, 1); /* nonblocking */
  if (r == 0 || r == AVCAP_EMPTY || r == AVCAP_OVERRUN) return 0;
  if (r < 0) return g_err = r;
  if ((size_t)r > size - sizeof(g_headers)) return g_err = AVCAP_INVALID;
  uint64_t pts, dts;
  memcpy(&pts, info + 8, 8);
  memcpy(&dts, info + 0x10, 8);
  /* Native clock: 240000 ticks/s. Anchor each session to the TSC epoch and
   * keep native cadence and PTS/DTS spacing. */
  if (!g_clock_set) {
    __uint128_t target = (__uint128_t)p_ReadTsc() * 240000u / g_tsc_frequency;
    if (target > UINT64_MAX) return g_err = AVCAP_INVALID;
    g_source_origin = pts;
    g_target_origin = (uint64_t)target;
    g_clock_set = 1;
  }
  if (video_timestamp(pts, &fr->pts_us) || video_timestamp(dts, &fr->dts_us))
    return g_err = AVCAP_INVALID;
  fr->len = (size_t)r;
  fr->keyframe = has_idr(buf, fr->len);
  /* The default encoder emits only one IDR; ask for one every 2 s so new
   * viewers (and viewers that dropped data) can resynchronise. */
  if (!g_have_keyframe_clock || fr->keyframe || fr->pts_us < g_keyframe_clock_us) {
    g_keyframe_clock_us = fr->pts_us;
    g_have_keyframe_clock = 1;
  } else if (fr->pts_us - g_keyframe_clock_us >= KEYFRAME_INTERVAL_US) {
    int kr = p_RequestKeyFrame(g_video);
    if (kr < 0) LOG("avcap: RequestKeyFrame -> 0x%x", kr);
    g_keyframe_clock_us = fr->pts_us;
  }
  /* Slices come without SPS/PPS: prefix the native headers to every IDR. */
  if (fr->keyframe && g_headers_len) {
    memmove(buf + g_headers_len, buf, fr->len);
    memcpy(buf, g_headers, g_headers_len);
    fr->len += g_headers_len;
  }
  g_err = 0;
  return 1;
}

int avcap_request_keyframe(void) {
  if (!g_video) return AVCAP_INVALID;
  int r = p_RequestKeyFrame(g_video);
  if (r < 0) LOG("avcap: on-demand RequestKeyFrame -> 0x%x", r);
  return r < 0 ? r : 0;
}

void avcap_close(void) {
  if (g_video) {
    LOG("avcap: Stop -> 0x%x", p_Stop(g_video));
    LOG("avcap: Close -> 0x%x", p_Close(g_video));
    g_video = NULL;
  }
  g_headers_len = 0;
  g_have_keyframe_clock = 0;
  g_clock_set = 0;
  resource_release();
}

void avcap_terminate(void) {
  avcap_close();
  if (g_ra_registered_small && p_RaClear) p_RaClear(g_opt.resource_1080);
  if (g_ra_registered_large && p_RaClear) p_RaClear(g_opt.resource_4k);
  g_ra_registered_small = g_ra_registered_large = 0;
  if (g_initialized) { p_Terminate(); g_initialized = 0; }
}
