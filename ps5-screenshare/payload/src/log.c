/* PS5 Screen Share - logging.
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later */
#include "log.h"

#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>

#define RING_SIZE (64 * 1024)

static char g_ring[RING_SIZE];
static size_t g_len;
static pthread_mutex_t g_mtx = PTHREAD_MUTEX_INITIALIZER;
static FILE *g_file;
static char g_tag[24] = "ps5ss";

void log_init(const char *tag, const char *filename) {
  if (tag) snprintf(g_tag, sizeof(g_tag), "%s", tag);
  mkdir(PS5SS_DATA_DIR, 0777);
  char path[256];
  snprintf(path, sizeof(path), "%s/%s", PS5SS_DATA_DIR, filename ? filename : "log.txt");
  /* Keep the previous run's log for diagnostics. */
  char old[260];
  snprintf(old, sizeof(old), "%s.1", path);
  rename(path, old);
  g_file = fopen(path, "w");
  if (g_file) setvbuf(g_file, NULL, _IOLBF, 0);
}

void LOG(const char *fmt, ...) {
  char line[1024];
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  int n = snprintf(line, sizeof(line), "[%s %5ld.%03ld] ", g_tag, (long)ts.tv_sec,
                   ts.tv_nsec / 1000000);
  if (n < 0) return;
  va_list ap;
  va_start(ap, fmt);
  int m = vsnprintf(line + n, sizeof(line) - (size_t)n - 1, fmt, ap);
  va_end(ap);
  if (m < 0) return;
  size_t len = strlen(line);
  line[len++] = '\n';
  line[len] = 0;

  pthread_mutex_lock(&g_mtx);
  fwrite(line, 1, len, stdout);
  fflush(stdout);
  if (g_file) fwrite(line, 1, len, g_file);
  if (len >= RING_SIZE) len = RING_SIZE - 1;
  if (g_len + len > RING_SIZE) {
    size_t drop = g_len + len - RING_SIZE;
    /* Drop whole lines from the front. */
    char *nl = memchr(g_ring + drop, '\n', g_len - drop);
    if (nl) drop = (size_t)(nl - g_ring) + 1;
    if (drop > g_len) drop = g_len;
    memmove(g_ring, g_ring + drop, g_len - drop);
    g_len -= drop;
  }
  memcpy(g_ring + g_len, line, len);
  g_len += len;
  pthread_mutex_unlock(&g_mtx);
}

size_t log_snapshot(char *out, size_t cap) {
  if (!out || !cap) return 0;
  pthread_mutex_lock(&g_mtx);
  size_t start = g_len + 1 > cap ? g_len + 1 - cap : 0;
  size_t n = g_len - start;
  memcpy(out, g_ring + start, n);
  out[n] = 0;
  pthread_mutex_unlock(&g_mtx);
  return n;
}
