/* PS5 Screen Share - configuration.
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later */
#include "config.h"

#include "log.h"
#include "protocol.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

void config_defaults(ps5ss_config *c) {
  memset(c, 0, sizeof(*c));
  c->port = PS5SS_DEFAULT_PORT;
  c->settings = (capture_settings){1920, 1080, 60, 8000, 1};
  c->variant = REQ_AUTO;
  c->resource_1080 = 0xb4;
  c->resource_4k = 0xb6;
  c->idle_timeout = 15;
  c->notify = 1;
  c->pad = 1;
}

int config_apply(ps5ss_config *c, const char *token) {
  char buf[128];
  snprintf(buf, sizeof(buf), "%s", token);
  char *eq = strchr(buf, '=');
  if (!eq) return -1;
  *eq = 0;
  char *key = buf, *val = eq + 1;
  while (*key && isspace((unsigned char)*key)) key++;
  for (char *e = key + strlen(key); e > key && isspace((unsigned char)e[-1]);) *--e = 0;
  while (*val && isspace((unsigned char)*val)) val++;
  for (char *e = val + strlen(val); e > val && isspace((unsigned char)e[-1]);) *--e = 0;
  long n = strtol(val, NULL, 0);
  if (!strcasecmp(key, "port")) {
    if (n < 1 || n > 64535) return -1;
    c->port = (int)n;
  } else if (!strcasecmp(key, "resolution") || !strcasecmp(key, "res")) {
    int w, h;
    if (settings_parse_resolution(val, &w, &h)) return -1;
    c->settings.width = w;
    c->settings.height = h;
    c->settings.kbps = settings_default_kbps(h);
  } else if (!strcasecmp(key, "fps")) {
    if (n != 30 && n != 60) return -1;
    c->settings.fps = (int)n;
  } else if (!strcasecmp(key, "bitrate") || !strcasecmp(key, "kbps")) {
    if (n < 1000 || n > 100000) return -1;
    c->settings.kbps = (int)n;
  } else if (!strcasecmp(key, "audio")) {
    c->settings.audio = n ? 1 : 0;
  } else if (!strcasecmp(key, "variant")) {
    if (!strcasecmp(val, "auto")) c->variant = REQ_AUTO;
    else if (!strcasecmp(val, "pws")) c->variant = REQ_PWS;
    else if (!strcasecmp(val, "native")) c->variant = REQ_NATIVE;
    else if (!strcasecmp(val, "synthetic")) c->variant = REQ_SYNTHETIC;
    else return -1;
  } else if (!strcasecmp(key, "resource_1080")) {
    if (n <= 0) return -1;
    c->resource_1080 = (int)n;
  } else if (!strcasecmp(key, "resource_4k")) {
    if (n <= 0) return -1;
    c->resource_4k = (int)n;
  } else if (!strcasecmp(key, "idle_timeout")) {
    if (n < 0) return -1;
    c->idle_timeout = (int)n;
  } else if (!strcasecmp(key, "notify")) {
    c->notify = n ? 1 : 0;
  } else if (!strcasecmp(key, "pad")) {
    c->pad = n ? 1 : 0;
  } else {
    return -1;
  }
  return 0;
}

void config_load_file(ps5ss_config *c) {
  char path[256];
  snprintf(path, sizeof(path), "%s/config.ini", PS5SS_DATA_DIR);
  FILE *f = fopen(path, "r");
  if (!f) return;
  char line[160];
  while (fgets(line, sizeof(line), f)) {
    char *p = line;
    while (*p && isspace((unsigned char)*p)) p++;
    p[strcspn(p, "\r\n")] = 0;
    if (!*p || *p == '#' || *p == ';' || *p == '[') continue;
    if (config_apply(c, p)) LOG("config: ignoring '%s'", p);
  }
  fclose(f);
}
