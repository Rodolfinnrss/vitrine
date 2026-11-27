/* PS5 Screen Share - service status.
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later */
#include "status.h"

#include "pad.h"
#include "settings.h"
#include "stream.h"

#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#ifndef PS5SS_VERSION
#define PS5SS_VERSION "dev"
#endif

static pthread_mutex_t g_mtx = PTHREAD_MUTEX_INITIALIZER;
static service_status g_st = {.state = "starting"};

void status_get(service_status *out) {
  pthread_mutex_lock(&g_mtx);
  *out = g_st;
  pthread_mutex_unlock(&g_mtx);
}

void status_set_state(const char *fmt, ...) {
  char text[sizeof(g_st.state)];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(text, sizeof(text), fmt, ap);
  va_end(ap);
  pthread_mutex_lock(&g_mtx);
  memcpy(g_st.state, text, sizeof(text));
  pthread_mutex_unlock(&g_mtx);
}

void status_set_capture(int width, int height, int fps, int kbps, int audio) {
  pthread_mutex_lock(&g_mtx);
  g_st.width = width; g_st.height = height; g_st.fps = fps; g_st.kbps = kbps;
  g_st.audio = audio;
  pthread_mutex_unlock(&g_mtx);
}

void status_set_error(int err) {
  pthread_mutex_lock(&g_mtx);
  g_st.last_error = err;
  pthread_mutex_unlock(&g_mtx);
}

void status_count_frame(size_t bytes, int keyframe) {
  pthread_mutex_lock(&g_mtx);
  g_st.frames++;
  g_st.bytes += bytes;
  if (keyframe) g_st.keyframes++;
  pthread_mutex_unlock(&g_mtx);
}

void status_count_audio(void) {
  pthread_mutex_lock(&g_mtx);
  g_st.audio_blocks++;
  pthread_mutex_unlock(&g_mtx);
}

void status_set_platform(uint32_t fw, const char *profile, unsigned generation) {
  pthread_mutex_lock(&g_mtx);
  g_st.fw = fw;
  snprintf(g_st.profile, sizeof(g_st.profile), "%s", profile ? profile : "");
  g_st.generation = generation;
  pthread_mutex_unlock(&g_mtx);
}

static void json_escape(char *out, size_t cap, const char *in) {
  size_t o = 0;
  for (; *in && o + 7 < cap; in++) {
    unsigned char ch = (unsigned char)*in;
    if (ch == '"' || ch == '\\') { out[o++] = '\\'; out[o++] = (char)ch; }
    else if (ch < 0x20) o += (size_t)snprintf(out + o, cap - o, "\\u%04x", ch);
    else out[o++] = (char)ch;
  }
  out[o] = 0;
}

size_t status_json(char *out, size_t cap, int port) {
  service_status st;
  status_get(&st);
  capture_settings cs;
  settings_get(&cs);
  char state[sizeof(st.state) * 2], clients[2048];
  json_escape(state, sizeof(state), st.state);
  bc_describe(clients, sizeof(clients));
  pad_info pad;
  pad_get_info(&pad);
  int n = snprintf(out, cap,
      "{\"app\":\"ps5-screenshare\",\"version\":\"%s\",\"protocol\":1,\"port\":%d,"
      "\"firmware\":\"%x.%02x\",\"firmware_id\":\"0x%08x\",\"profile\":\"%s\","
      "\"generation\":%u,\"state\":\"%s\",\"last_error\":\"0x%08x\","
      "\"active\":{\"width\":%d,\"height\":%d,\"fps\":%d,\"kbps\":%d,\"audio\":%d},"
      "\"requested\":{\"resolution\":\"%s\",\"fps\":%d,\"kbps\":%d,\"audio\":%d},"
      "\"frames\":%llu,\"bytes\":%llu,\"keyframes\":%llu,\"audio_blocks\":%llu,"
      "\"pad\":{\"available\":%d,\"owned\":%d,\"writes\":%llu,\"buttons\":\"0x%x\"},"
      "\"clients\":%s}",
      PS5SS_VERSION, port, (st.fw >> 24) & 0xff, (st.fw >> 16) & 0xff, st.fw,
      st.profile, st.generation, state, (unsigned)st.last_error, st.width,
      st.height, st.fps, st.kbps, st.audio, settings_resolution_name(cs.height),
      cs.fps, cs.kbps, cs.audio, (unsigned long long)st.frames,
      (unsigned long long)st.bytes, (unsigned long long)st.keyframes,
      (unsigned long long)st.audio_blocks, pad.available, pad.owned,
      (unsigned long long)pad.writes, pad.buttons, clients);
  if (n < 0) return 0;
  return (size_t)n < cap ? (size_t)n : cap - 1;
}
