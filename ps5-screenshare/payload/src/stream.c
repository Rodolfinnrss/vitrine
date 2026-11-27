/* PS5 Screen Share - packet broadcaster with bounded per-client queues.
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later */
#include "stream.h"

#include "wire.h"
#include "log.h"
#include "protocol.h"

#include <errno.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#define QUEUE_PACKETS 1024
#define QUEUE_BYTES (8u * 1024u * 1024u)
/* A live view is useless when it lags: resync a client whose oldest queued
 * packet waited longer than this. */
#define QUEUE_MAX_AGE_MS 1500

struct packet {
  atomic_int refs;
  uint8_t type, flags;
  size_t len;          /* header + payload */
  uint8_t data[];
};

struct client {
  int in_use;
  wire *lk;
  char peer[64];
  pthread_mutex_t mtx;
  pthread_cond_t cond;
  packet *q[QUEUE_PACKETS];
  uint64_t qtime[QUEUE_PACKETS];   /* enqueue time, ms */
  unsigned head, count;
  size_t bytes;
  int closed, need_key, want_audio;
  uint64_t sent_bytes, sent_video, drops;
  time_t since;
};

static client g_clients[STREAM_MAX_CLIENTS];
static pthread_mutex_t g_list = PTHREAD_MUTEX_INITIALIZER;
static packet *g_info;
static atomic_int g_key_request;

static void be16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)(v >> 8); p[1] = (uint8_t)v; }
static void be32(uint8_t *p, uint32_t v) {
  for (int i = 0; i < 4; i++) p[i] = (uint8_t)(v >> (24 - 8 * i));
}
static void be64(uint8_t *p, uint64_t v) {
  for (int i = 0; i < 8; i++) p[i] = (uint8_t)(v >> (56 - 8 * i));
}

packet *packet_new(uint8_t type, uint8_t flags, uint64_t pts_us,
                   const void *a, size_t alen, const void *b, size_t blen) {
  size_t payload = alen + blen;
  if (payload > UINT32_MAX) return NULL;
  packet *p = malloc(sizeof(*p) + PS5SS_HEADER_LEN + payload);
  if (!p) return NULL;
  atomic_init(&p->refs, 1);
  p->type = type;
  p->flags = flags;
  p->len = PS5SS_HEADER_LEN + payload;
  uint8_t *h = p->data;
  h[0] = type;
  h[1] = flags;
  be16(h + 2, 0);
  be32(h + 4, (uint32_t)payload);
  be64(h + 8, pts_us);
  if (alen) memcpy(h + PS5SS_HEADER_LEN, a, alen);
  if (blen) memcpy(h + PS5SS_HEADER_LEN + alen, b, blen);
  return p;
}

static packet *packet_ref(packet *p) {
  if (p) atomic_fetch_add(&p->refs, 1);
  return p;
}

void packet_unref(packet *p) {
  if (p && atomic_fetch_sub(&p->refs, 1) == 1) free(p);
}

uint8_t packet_type(const packet *p) { return p ? p->type : 0xff; }

void bc_init(void) {
  for (int i = 0; i < STREAM_MAX_CLIENTS; i++) {
    pthread_mutex_init(&g_clients[i].mtx, NULL);
    pthread_cond_init(&g_clients[i].cond, NULL);
  }
}

void bc_request_keyframe(void) { atomic_store(&g_key_request, 1); }
int bc_take_keyframe_request(void) { return atomic_exchange(&g_key_request, 0); }

static uint64_t mono_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint64_t)t.tv_sec * 1000u + (uint64_t)t.tv_nsec / 1000000u;
}

static int is_media(const packet *p) {
  return p->type == PKT_VIDEO || p->type == PKT_AUDIO;
}

/* Caller holds c->mtx. Takes a new reference when queued. */
static void enqueue_locked(client *c, packet *p) {
  if (c->closed) return;
  uint64_t now = mono_ms();
  int too_old = c->count && is_media(p) && now - c->qtime[c->head] > QUEUE_MAX_AGE_MS;
  if (too_old || c->count == QUEUE_PACKETS || c->bytes + p->len > QUEUE_BYTES) {
    /* Too far behind: drop queued media, keep control packets (compacted in
     * place, preserving order), and restart this client at the next IDR. */
    unsigned kept = 0;
    size_t kept_bytes = 0;
    for (unsigned i = 0; i < c->count; i++) {
      unsigned slot = (c->head + i) % QUEUE_PACKETS;
      packet *q = c->q[slot];
      if (is_media(q)) { packet_unref(q); continue; }
      unsigned dst = (c->head + kept) % QUEUE_PACKETS;
      c->q[dst] = q;
      c->qtime[dst] = now;
      kept++;
      kept_bytes += q->len;
    }
    c->count = kept;
    c->bytes = kept_bytes;
    c->need_key = 1;
    c->drops++;
    bc_request_keyframe();
    if (c->count == QUEUE_PACKETS) return;
  }
  if (p->type == PKT_AUDIO && !c->want_audio) return;
  if (p->type == PKT_VIDEO && c->need_key) {
    if (!(p->flags & PKT_FLAG_KEYFRAME)) return;
    c->need_key = 0;
  }
  unsigned slot = (c->head + c->count) % QUEUE_PACKETS;
  c->q[slot] = packet_ref(p);
  c->qtime[slot] = now;
  c->count++;
  c->bytes += p->len;
  pthread_cond_signal(&c->cond);
}

void bc_send_to(client *c, packet *p) {
  if (!c || !p) return;
  pthread_mutex_lock(&c->mtx);
  enqueue_locked(c, p);
  pthread_mutex_unlock(&c->mtx);
}

void bc_publish(packet *p) {
  if (!p) return;
  pthread_mutex_lock(&g_list);
  for (int i = 0; i < STREAM_MAX_CLIENTS; i++) {
    client *c = &g_clients[i];
    if (!c->in_use) continue;
    pthread_mutex_lock(&c->mtx);
    enqueue_locked(c, p);
    pthread_mutex_unlock(&c->mtx);
  }
  pthread_mutex_unlock(&g_list);
  packet_unref(p);
}

void bc_set_info(packet *p) {
  if (!p) return;
  pthread_mutex_lock(&g_list);
  packet *old = g_info;
  g_info = packet_ref(p);
  pthread_mutex_unlock(&g_list);
  packet_unref(old);
  bc_publish(packet_ref(p));
}

void bc_status(const char *fmt, ...) {
  char text[512];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(text, sizeof(text), fmt, ap);
  va_end(ap);
  if (n < 0) return;
  if ((size_t)n >= sizeof(text)) n = sizeof(text) - 1;
  bc_publish(packet_new(PKT_STATUS, 0, 0, text, (size_t)n, NULL, 0));
}

client *bc_add(wire *lk, const char *peer, int want_audio) {
  client *c = NULL;
  pthread_mutex_lock(&g_list);
  for (int i = 0; i < STREAM_MAX_CLIENTS; i++) {
    if (!g_clients[i].in_use) { c = &g_clients[i]; break; }
  }
  if (c) {
    pthread_mutex_lock(&c->mtx);
    c->in_use = 1;
    c->lk = lk;
    snprintf(c->peer, sizeof(c->peer), "%s", peer ? peer : "?");
    c->head = c->count = 0;
    c->bytes = 0;
    c->closed = 0;
    c->need_key = 1;
    c->want_audio = want_audio;
    c->sent_bytes = c->sent_video = c->drops = 0;
    c->since = time(NULL);
    if (g_info) enqueue_locked(c, g_info);
    pthread_mutex_unlock(&c->mtx);
  }
  pthread_mutex_unlock(&g_list);
  if (c) bc_request_keyframe();
  return c;
}

void bc_client_writer(client *c) {
  uint8_t hello[8] = {'P', 'S', '5', 'S', 0, PS5SS_PROTO_VERSION, 0, 0};
  if (wire_send(c->lk, hello, sizeof(hello))) { bc_client_close(c); return; }
  for (;;) {
    pthread_mutex_lock(&c->mtx);
    int idle = 0;
    while (!c->count && !c->closed) {
      struct timespec ts;
      clock_gettime(CLOCK_REALTIME, &ts);
      ts.tv_sec += 1;
      if (pthread_cond_timedwait(&c->cond, &c->mtx, &ts) == ETIMEDOUT && !c->count) {
        idle = 1;
        break;
      }
    }
    if (c->closed) { pthread_mutex_unlock(&c->mtx); break; }
    packet *p = NULL;
    if (!idle) {
      p = c->q[c->head];
      c->head = (c->head + 1) % QUEUE_PACKETS;
      c->count--;
      c->bytes -= p->len;
    }
    pthread_mutex_unlock(&c->mtx);
    int r;
    if (idle) {
      uint8_t ka[PS5SS_HEADER_LEN] = {PKT_KEEPALIVE};
      r = wire_send(c->lk, ka, sizeof(ka));
    } else {
      r = wire_send(c->lk, p->data, p->len);
      if (!r) {
        c->sent_bytes += p->len;
        if (p->type == PKT_VIDEO) c->sent_video++;
      }
      packet_unref(p);
    }
    if (r) break;
  }
  bc_client_close(c);
}

void bc_client_close(client *c) {
  if (!c) return;
  pthread_mutex_lock(&c->mtx);
  if (!c->closed) {
    c->closed = 1;
    shutdown(wire_fd(c->lk), SHUT_RDWR);
  }
  pthread_cond_broadcast(&c->cond);
  pthread_mutex_unlock(&c->mtx);
}

void bc_client_set_audio(client *c, int want) {
  if (!c) return;
  pthread_mutex_lock(&c->mtx);
  c->want_audio = want ? 1 : 0;
  pthread_mutex_unlock(&c->mtx);
}

void bc_remove(client *c) {
  if (!c) return;
  pthread_mutex_lock(&g_list);
  pthread_mutex_lock(&c->mtx);
  for (unsigned i = 0; i < c->count; i++)
    packet_unref(c->q[(c->head + i) % QUEUE_PACKETS]);
  c->count = 0;
  c->bytes = 0;
  c->lk = NULL;
  c->in_use = 0;
  pthread_mutex_unlock(&c->mtx);
  pthread_mutex_unlock(&g_list);
}

int bc_client_count(void) {
  int n = 0;
  pthread_mutex_lock(&g_list);
  for (int i = 0; i < STREAM_MAX_CLIENTS; i++) n += g_clients[i].in_use;
  pthread_mutex_unlock(&g_list);
  return n;
}

size_t bc_describe(char *out, size_t cap) {
  size_t len = 0;
  if (!out || cap < 3) return 0;
  out[len++] = '[';
  pthread_mutex_lock(&g_list);
  int first = 1;
  time_t now = time(NULL);
  for (int i = 0; i < STREAM_MAX_CLIENTS; i++) {
    client *c = &g_clients[i];
    if (!c->in_use) continue;
    pthread_mutex_lock(&c->mtx);
    int n = snprintf(out + len, cap - len,
                     "%s{\"peer\":\"%s\",\"seconds\":%ld,\"queued_bytes\":%zu,"
                     "\"sent_bytes\":%llu,\"video_frames\":%llu,\"resyncs\":%llu,\"audio\":%d}",
                     first ? "" : ",", c->peer, (long)(now - c->since), c->bytes,
                     (unsigned long long)c->sent_bytes, (unsigned long long)c->sent_video,
                     (unsigned long long)c->drops, c->want_audio);
    pthread_mutex_unlock(&c->mtx);
    if (n < 0 || (size_t)n >= cap - len - 1) break;
    len += (size_t)n;
    first = 0;
  }
  pthread_mutex_unlock(&g_list);
  if (len + 2 <= cap) { out[len++] = ']'; out[len] = 0; }
  else { out[0] = '['; out[1] = ']'; out[2] = 0; len = 2; }
  return len;
}
