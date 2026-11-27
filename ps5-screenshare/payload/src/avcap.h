/* PS5 Screen Share - H.264 capture of the console's video output.
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Built on libSceAvcap2, the console's own AV capture service (used by Share
 * and Remote Play). It taps the composited HDMI output and returns it already
 * encoded by the hardware H.264 encoder. The open sequence, ResourceArbitrator
 * negotiation, header handling and timestamp rebasing are adapted from
 * ps5-web-stream by heydemoura (GPL-3.0-or-later); see its docs/AVCAP2.md.
 */
#ifndef PS5SS_AVCAP_H
#define PS5SS_AVCAP_H

#include <stddef.h>
#include <stdint.h>

#include "fwprofiles.h"

typedef struct {
  int width, height, fps, kbps;
} avcap_config;

typedef struct {
  size_t len;
  uint64_t pts_us, dts_us;
  int keyframe;
} avcap_frame;

typedef struct {
  req_variant variant;   /* REQ_AUTO picks from the firmware profile */
  int resource_1080;     /* ResourceArbitrator id for 720p/1080p (0xb4) */
  int resource_4k;       /* ... for 1440p/2160p (0xb6) */
} avcap_options;

void avcap_set_options(const avcap_options *o);
int  avcap_load(void);
int  avcap_init(void);
int  avcap_open(const avcap_config *cfg);
int  avcap_resource_id(void);
/* 1 frame, 0 nothing ready, <0 fatal SCE error. */
int  avcap_read_video(uint8_t *buf, size_t bufsize, avcap_frame *fr);
int  avcap_request_keyframe(void);
void avcap_close(void);
void avcap_terminate(void);
int  avcap_last_error(void);
/* e.g. "fw 12.00 exact, request pws 0x2e0" */
const char *avcap_profile_desc(void);

#endif
