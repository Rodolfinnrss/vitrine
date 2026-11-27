/* PS5 Screen Share - service status shared by capture, HTTP and discovery.
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later */
#ifndef PS5SS_STATUS_H
#define PS5SS_STATUS_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
  char state[96];          /* idle / starting / streaming / error text */
  int width, height, fps, kbps;   /* active capture, 0 when closed */
  int audio;               /* audio capture active */
  int last_error;
  uint64_t frames, bytes, keyframes, audio_blocks;
  uint32_t fw;
  char profile[64];        /* firmware profile and request variant */
  unsigned generation;     /* process generation under the supervisor */
  char relay_host[64];     /* empty when the relay is not configured */
  int relay_port;
  char pairing_id[17];     /* public id the relay routes by; never the secret */
} service_status;

void status_get(service_status *out);
void status_set_state(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
void status_set_capture(int width, int height, int fps, int kbps, int audio);
void status_set_error(int err);
void status_count_frame(size_t bytes, int keyframe);
void status_count_audio(void);
void status_set_platform(uint32_t fw, const char *profile, unsigned generation);
void status_set_relay(const char *host, int port, const char *pairing_id);
/* JSON object with status, settings and clients. */
size_t status_json(char *out, size_t cap, int port);

#endif
