/* PS5 Screen Share - host test doubles for avcap.h and audio.h.
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Replays an Annex-B H.264 file (split at access unit delimiters) at the
 * requested frame rate and generates a 440 Hz tone, so the server, protocol
 * and Android client can be exercised without a console.
 *   PS5SS_MOCK_H264=file.h264   input (must contain AUD NAL units)
 *   PS5SS_MOCK_FAIL_OPEN=n      first n opens fail with 0x81950001
 *   PS5SS_MOCK_LOSE_AFTER=n     the session fails with 0x81950009 after n frames
 *   PS5SS_MOCK_STUCK=1          after that loss every open fails (0x81950008),
 *                               like a console whose video-out mode changed
 */
#include "audio.h"
#include "avcap.h"
#include "log.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef struct { size_t off, len; int key; } au;

static uint8_t *g_data;
static au *g_aus;
static size_t g_count, g_next;
static int g_open, g_fps, g_opens, g_key_requests, g_lost;
static uint64_t g_start_us, g_frame, g_session_frames;
static char g_desc[64] = "mock";

static uint64_t now_us(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint64_t)t.tv_sec * 1000000u + (uint64_t)t.tv_nsec / 1000u;
}

static int env_int(const char *name) {
  const char *v = getenv(name);
  return v ? atoi(v) : 0;
}

static int load(void) {
  if (g_data) return 0;
  const char *path = getenv("PS5SS_MOCK_H264");
  FILE *f = path ? fopen(path, "rb") : NULL;
  if (!f) { LOG("mock: set PS5SS_MOCK_H264"); return -1; }
  fseek(f, 0, SEEK_END);
  long size = ftell(f);
  fseek(f, 0, SEEK_SET);
  g_data = malloc((size_t)size);
  if (!g_data || fread(g_data, 1, (size_t)size, f) != (size_t)size) { fclose(f); return -1; }
  fclose(f);
  size_t cap = 1024;
  g_aus = malloc(cap * sizeof(*g_aus));
  for (size_t i = 0; i + 4 < (size_t)size; i++) {
    int sc3 = g_data[i] == 0 && g_data[i + 1] == 0 && g_data[i + 2] == 1;
    if (!sc3) continue;
    size_t start = (i > 0 && g_data[i - 1] == 0) ? i - 1 : i;
    int type = g_data[i + 3] & 31;
    if (type == 9) {
      if (g_count) g_aus[g_count - 1].len = start - g_aus[g_count - 1].off;
      if (g_count == cap) g_aus = realloc(g_aus, (cap *= 2) * sizeof(*g_aus));
      g_aus[g_count++] = (au){start, 0, 0};
    } else if (type == 5 && g_count) {
      g_aus[g_count - 1].key = 1;
    }
  }
  if (g_count) g_aus[g_count - 1].len = (size_t)size - g_aus[g_count - 1].off;
  LOG("mock: %zu access units from %s", g_count, path);
  return g_count ? 0 : -1;
}

void avcap_set_options(const avcap_options *o) { (void)o; }
int avcap_load(void) { return load(); }
int avcap_init(void) { return load(); }
int avcap_resource_id(void) { return g_open ? 0xb4 : -1; }
int avcap_last_error(void) { return 0; }
const char *avcap_profile_desc(void) { return g_desc; }

int avcap_open(const avcap_config *cfg) {
  if (load()) return -1;
  g_opens++;
  if (g_opens <= env_int("PS5SS_MOCK_FAIL_OPEN")) return (int)0x81950001;
  if (g_lost && env_int("PS5SS_MOCK_STUCK")) return (int)0x81950008;
  snprintf(g_desc, sizeof(g_desc), "mock %dx%d", cfg->width, cfg->height);
  g_fps = cfg->fps;
  g_open = 1;
  g_next = 0;
  g_frame = 0;
  g_session_frames = 0;
  g_start_us = now_us();
  LOG("mock: open %dx%d@%d %d kbps", cfg->width, cfg->height, cfg->fps, cfg->kbps);
  return 0;
}

int avcap_read_video(uint8_t *buf, size_t size, avcap_frame *fr) {
  if (!g_open) return (int)0x81950001;
  int lose = env_int("PS5SS_MOCK_LOSE_AFTER");
  if (lose && g_session_frames >= (uint64_t)lose && g_opens == 1 + env_int("PS5SS_MOCK_FAIL_OPEN")) {
    g_lost = 1;
    return (int)0x81950009;
  }
  uint64_t due = g_start_us + g_frame * 1000000u / (unsigned)g_fps;
  if (now_us() < due) return 0;
  /* After the loop wraps, restart from the first IDR. */
  if (g_next >= g_count) g_next = 0;
  au a = g_aus[g_next++];
  if (a.len > size) return (int)0x81950001;
  memcpy(buf, g_data + a.off, a.len);
  fr->len = a.len;
  fr->pts_us = fr->dts_us = g_frame * 1000000u / (unsigned)g_fps;
  fr->keyframe = a.key;
  g_frame++;
  g_session_frames++;
  return 1;
}

int avcap_request_keyframe(void) { g_key_requests++; return 0; }
void avcap_close(void) { g_open = 0; }
void avcap_terminate(void) { g_open = 0; }

struct audio_capture {
  uint64_t start_us, blocks;
  double phase;
};

audio_capture *audio_capture_open(int resource_id) {
  if (resource_id < 0 || getenv("PS5SS_MOCK_NO_AUDIO")) return NULL;
  audio_capture *a = calloc(1, sizeof(*a));
  if (a) a->start_us = now_us();
  return a;
}

void audio_capture_close(audio_capture *a) { free(a); }

int audio_capture_read(audio_capture *a, int16_t *pcm, uint64_t *pts_us) {
  uint64_t due = a->start_us + a->blocks * AUDIO_FRAME_SAMPLES * 1000000u / AUDIO_SAMPLE_RATE;
  if (now_us() < due) return 0;
  for (int i = 0; i < AUDIO_FRAME_SAMPLES; i++) {
    int16_t v = (int16_t)(sin(a->phase) * 6000.0);
    a->phase += 2.0 * M_PI * 440.0 / AUDIO_SAMPLE_RATE;
    pcm[2 * i] = pcm[2 * i + 1] = v;
  }
  *pts_us = a->blocks * AUDIO_FRAME_SAMPLES * 1000000u / AUDIO_SAMPLE_RATE;
  a->blocks++;
  return AUDIO_FRAME_SAMPLES;
}
