/* PS5 Screen Share - libSceAvcap2 system audio capture (console build).
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * Copyright (C) 2026 heydemoura (ps5-web-stream, from which the open record
 *                    and clock handling are adapted)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "audio.h"

#include "log.h"

#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define AUDIO_FLOATS (AUDIO_FRAME_SAMPLES * AUDIO_CHANNELS)

struct audio_capture {
  void *lib, *kernel;
  int64_t handle;
  int (*read)(int64_t, void *, size_t, void *, int);
  int (*stop)(int64_t);
  int (*close)(int64_t);
  uint64_t (*read_tsc)(void);
  uint64_t tsc_frequency;
  uint64_t first_ticks, last_ticks, target_ticks;
  int clock_set;
  float pcm[AUDIO_FLOATS];
};

static void *load_library(const char *name) {
  void *lib = dlopen(name, RTLD_LAZY | RTLD_GLOBAL);
  if (!lib) {
    char path[128];
    snprintf(path, sizeof(path), "/system/common/lib/%s", name);
    lib = dlopen(path, RTLD_LAZY | RTLD_GLOBAL);
  }
  if (!lib) LOG("audio: load %s failed: %s", name, dlerror());
  return lib;
}

audio_capture *audio_capture_open(int resource_id) {
  if (resource_id < 0) return NULL;
  audio_capture *s = calloc(1, sizeof(*s));
  if (!s) return NULL;
  s->lib = load_library("libSceAvcap2.sprx");
  if (!s->lib) { free(s); return NULL; }
  int (*open_audio)(int64_t *, void *, int) = dlsym(s->lib, "sceAvcap2OpenAudio");
  int (*start)(int64_t) = dlsym(s->lib, "sceAvcap2Start");
  s->read = dlsym(s->lib, "sceAvcap2ReadAudio");
  s->stop = dlsym(s->lib, "sceAvcap2Stop");
  s->close = dlsym(s->lib, "sceAvcap2Close");
  s->kernel = load_library("libkernel.sprx");
  if (s->kernel) {
    s->read_tsc = dlsym(s->kernel, "sceKernelReadTsc");
    uint64_t (*frequency)(void) = dlsym(s->kernel, "sceKernelGetTscFrequency");
    s->tsc_frequency = frequency ? frequency() : 0;
  }
  if (!open_audio || !start || !s->read || !s->stop || !s->close ||
      !s->read_tsc || !s->tsc_frequency) {
    LOG("audio: required symbols unavailable");
    audio_capture_close(s);
    return NULL;
  }
  /* u64 record size, u64 nested format size, then u32 fields. */
  uint32_t params[0x38 / 4] = {0};
  params[0] = 0x38;
  params[2] = 0x18;
  params[4] = 2;                      /* AudioSecond device (per-client key) */
  params[5] = 2;                      /* Remote Play system mix */
  params[7] = (uint32_t)resource_id;  /* must match the RUNNING video resource */
  int r = open_audio(&s->handle, params, 0);
  LOG("audio: OpenAudio(res=0x%x) -> 0x%x", resource_id, r);
  if (r != 0 || !s->handle) {
    s->handle = 0;
    audio_capture_close(s);
    return NULL;
  }
  r = start(s->handle);
  LOG("audio: Start -> 0x%x", r);
  if (r != 0) { audio_capture_close(s); return NULL; }
  return s;
}

void audio_capture_close(audio_capture *s) {
  if (!s) return;
  if (s->handle) {
    int stopped = s->stop(s->handle);
    LOG("audio: Stop -> 0x%x, Close -> 0x%x", stopped, s->close(s->handle));
  }
  if (s->lib) dlclose(s->lib);
  if (s->kernel) dlclose(s->kernel);
  free(s);
}

static int rebase(audio_capture *s, uint64_t source, uint64_t *us) {
  if (!s->clock_set) {
    /* A fresh native device starts at TSC*240000/freq plus one block (5120
     * ticks) and advances 5 ticks per sample; rebase once to that epoch. */
    __uint128_t native = (__uint128_t)s->read_tsc() * 240000u / s->tsc_frequency;
    native += AUDIO_FRAME_SAMPLES * 5u;
    if (native > UINT64_MAX) return -1;
    s->first_ticks = source;
    s->target_ticks = (uint64_t)native;
  } else if (source < s->last_ticks) {
    return -1;
  }
  uint64_t delta = source - s->first_ticks;
  if (delta > UINT64_MAX - s->target_ticks) return -1;
  __uint128_t converted = (__uint128_t)(s->target_ticks + delta) * 1000000u / 240000u;
  if (converted > UINT64_MAX) return -1;
  *us = (uint64_t)converted;
  s->last_ticks = source;
  s->clock_set = 1;
  return 0;
}

int audio_capture_read(audio_capture *s, int16_t *out, uint64_t *pts_us) {
  if (!s || !out || !pts_us) return -1;
  uint64_t meta[2] = {0x10, 0};
  int r = s->read(s->handle, s->pcm, sizeof(s->pcm), meta, 1);
  if (r == 0 || (uint32_t)r == 0x81950002u || (uint32_t)r == 0x81950004u) return 0;
  if (r < 0) return r;
  if (r != (int)sizeof(s->pcm)) {
    LOG("audio: unexpected PCM block size %d", r);
    return -1;
  }
  if (rebase(s, meta[1], pts_us) < 0) {
    LOG("audio: capture clock regressed");
    return -1;
  }
  for (size_t i = 0; i < AUDIO_FLOATS; i++) {
    float v = s->pcm[i];
    if (!(v == v)) v = 0;           /* NaN */
    if (v > 1.0f) v = 1.0f;
    else if (v < -1.0f) v = -1.0f;
    out[i] = (int16_t)(v * 32767.0f);
  }
  return AUDIO_FRAME_SAMPLES;
}
