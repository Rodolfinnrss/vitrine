/* PS5 Screen Share - configuration (config.ini and ELF loader arguments).
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Optional file /data/ps5-screenshare/config.ini, one key=value per line:
 *   port=9700            TCP stream/HTTP port and UDP discovery port
 *   resolution=1080p     720p | 1080p | 1440p | 2160p
 *   fps=60               30 | 60
 *   bitrate=8000         kbit/s
 *   audio=1              capture system audio
 *   variant=auto         auto | pws | native | synthetic (OpenVideo record)
 *   resource_1080=0xb4   ResourceArbitrator id used for 720p/1080p
 *   resource_4k=0xb6     ResourceArbitrator id used for 1440p/2160p
 *   idle_timeout=15      seconds to keep capturing after the last viewer left
 *   notify=1             console notifications
 */
#ifndef PS5SS_CONFIG_H
#define PS5SS_CONFIG_H

#include "fwprofiles.h"
#include "settings.h"

typedef struct {
  int port;
  capture_settings settings;
  req_variant variant;
  int resource_1080, resource_4k;
  int idle_timeout;
  int notify;
} ps5ss_config;

void config_defaults(ps5ss_config *c);
/* Apply one "key=value" token. Returns 0 if understood. */
int config_apply(ps5ss_config *c, const char *token);
/* Load PS5SS_DATA_DIR/config.ini if present. */
void config_load_file(ps5ss_config *c);

#endif
