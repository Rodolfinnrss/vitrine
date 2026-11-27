/* PS5 Screen Share - shared capture settings.
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later */
#ifndef PS5SS_SETTINGS_H
#define PS5SS_SETTINGS_H

typedef struct {
  int width, height;
  int fps;    /* 30 or 60 */
  int kbps;   /* video bitrate */
  int audio;  /* capture system audio */
} capture_settings;

void settings_init(const capture_settings *initial);
/* Returns the revision; incremented whenever the settings change. */
unsigned settings_get(capture_settings *out);
/* Apply "key=value" tokens (res, fps, bitrate) from a text line on top
 * of the current settings. Returns 1 if changed, 0 if unchanged, -1 invalid. */
int settings_apply_tokens(const char *line);
/* Replace all settings (validated). Same return convention. */
int settings_set(const capture_settings *in);
int settings_valid(const capture_settings *s);

int settings_parse_resolution(const char *s, int *w, int *h);
const char *settings_resolution_name(int height);
int settings_default_kbps(int height);

#endif
