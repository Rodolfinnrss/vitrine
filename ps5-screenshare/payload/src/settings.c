/* PS5 Screen Share - shared capture settings.
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later */
#include "settings.h"

#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

static pthread_mutex_t g_mtx = PTHREAD_MUTEX_INITIALIZER;
static capture_settings g_cur = {1920, 1080, 60, 8000, 1};
static unsigned g_rev = 1;

int settings_parse_resolution(const char *s, int *w, int *h) {
  static const struct { const char *name; int w, h; } table[] = {
    {"720p", 1280, 720}, {"1080p", 1920, 1080}, {"1440p", 2560, 1440},
    {"2160p", 3840, 2160}, {"4k", 3840, 2160}, {"720", 1280, 720},
    {"1080", 1920, 1080}, {"1440", 2560, 1440}, {"2160", 3840, 2160},
  };
  if (!s) return -1;
  for (size_t i = 0; i < sizeof(table) / sizeof(table[0]); i++) {
    if (!strcasecmp(s, table[i].name)) {
      *w = table[i].w; *h = table[i].h;
      return 0;
    }
  }
  return -1;
}

const char *settings_resolution_name(int height) {
  switch (height) {
    case 720: return "720p";
    case 1080: return "1080p";
    case 1440: return "1440p";
    case 2160: return "2160p";
    default: return "?";
  }
}

int settings_default_kbps(int height) {
  switch (height) {
    case 720: return 5000;
    case 1440: return 16000;
    case 2160: return 32000;
    default: return 8000;
  }
}

int settings_valid(const capture_settings *s) {
  if (!s) return 0;
  int w, h;
  if (settings_parse_resolution(settings_resolution_name(s->height), &w, &h) ||
      w != s->width) return 0;
  if (s->fps != 30 && s->fps != 60) return 0;
  if (s->kbps < 1000 || s->kbps > 100000) return 0;
  return s->audio == 0 || s->audio == 1;
}

unsigned settings_get(capture_settings *out) {
  pthread_mutex_lock(&g_mtx);
  if (out) *out = g_cur;
  unsigned rev = g_rev;
  pthread_mutex_unlock(&g_mtx);
  return rev;
}

int settings_set(const capture_settings *in) {
  if (!settings_valid(in)) return -1;
  pthread_mutex_lock(&g_mtx);
  int changed = memcmp(&g_cur, in, sizeof(*in)) != 0;
  if (changed) { g_cur = *in; g_rev++; }
  pthread_mutex_unlock(&g_mtx);
  return changed;
}

void settings_init(const capture_settings *initial) {
  if (initial && settings_valid(initial)) settings_set(initial);
}

int settings_apply_tokens(const char *line) {
  capture_settings next;
  settings_get(&next);
  int res_changed = 0, rate_given = 0;
  char buf[256];
  strncpy(buf, line ? line : "", sizeof(buf) - 1);
  buf[sizeof(buf) - 1] = 0;
  char *save = NULL;
  for (char *tok = strtok_r(buf, " \t\r\n", &save); tok;
       tok = strtok_r(NULL, " \t\r\n", &save)) {
    char *eq = strchr(tok, '=');
    if (!eq) continue;
    *eq = 0;
    const char *key = tok, *val = eq + 1;
    char *end = NULL;
    if (!strcasecmp(key, "res") || !strcasecmp(key, "resolution")) {
      int w, h;
      if (!strcasecmp(val, "auto") || !*val) continue;
      if (settings_parse_resolution(val, &w, &h)) return -1;
      if (h != next.height) res_changed = 1;
      next.width = w; next.height = h;
    } else if (!strcasecmp(key, "fps")) {
      long v = strtol(val, &end, 10);
      if (!*val || *end) return -1;
      next.fps = (int)v;
    } else if (!strcasecmp(key, "bitrate") || !strcasecmp(key, "kbps")) {
      if (!strcasecmp(val, "auto") || !*val) continue;
      long v = strtol(val, &end, 10);
      if (!*val || *end || v <= 0) return -1;
      next.kbps = (int)v;
      rate_given = 1;
    }
  }
  /* A resolution change without an explicit bitrate uses that mode's default. */
  if (res_changed && !rate_given) next.kbps = settings_default_kbps(next.height);
  return settings_set(&next);
}
