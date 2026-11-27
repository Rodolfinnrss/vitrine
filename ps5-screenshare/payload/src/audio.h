/* PS5 Screen Share - system audio capture (48 kHz stereo).
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * libSceAvcap2 audio open record and read semantics adapted from
 * ps5-web-stream (GPL-3.0-or-later). */
#ifndef PS5SS_AUDIO_H
#define PS5SS_AUDIO_H

#include <stdint.h>

#define AUDIO_SAMPLE_RATE 48000
#define AUDIO_CHANNELS 2
#define AUDIO_FRAME_SAMPLES 1024

typedef struct audio_capture audio_capture;

/* resource_id must be the RUNNING video resource (avcap_resource_id()). */
audio_capture *audio_capture_open(int resource_id);
void audio_capture_close(audio_capture *a);
/* Fills AUDIO_FRAME_SAMPLES interleaved s16 stereo frames.
 * Returns AUDIO_FRAME_SAMPLES, 0 when nothing is ready, <0 on failure. */
int audio_capture_read(audio_capture *a, int16_t *pcm, uint64_t *pts_us);

#endif
