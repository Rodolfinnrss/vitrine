/* PS5 Screen Share - firmware-specific libSceAvcap2 request geometry.
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The OpenVideo parameter record is a versioned structure whose size and
 * nested-group offsets change between firmware releases. The geometry table
 * (fwprofiles_data.c) is generated from the per-firmware measurements made by
 * PBS-Payload (https://github.com/the-mentor/PBS-Payload, GPL-3.0-or-later).
 * The field meanings used to fill the 0x2e0-byte record follow ps5-web-stream
 * (https://github.com/heydemoura/ps5-web-stream, GPL-3.0-or-later).
 */
#ifndef PS5SS_FWPROFILES_H
#define PS5SS_FWPROFILES_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint16_t off;
  uint8_t len;
  uint8_t bytes[16];
} fw_init;

typedef struct {
  uint16_t off, size, desc;
} fw_group;

typedef struct {
  uint32_t fw;          /* reference firmware id 0xMMmmBBBB */
  uint16_t request_size;
  uint16_t kind_off;
  fw_group rate;
  fw_group image;
  uint16_t width_off, height_off, paste_off, vmode_off, mask_off, mask_span;
  const fw_init *inits;
  uint8_t ninit;
} fw_profile;

extern const fw_profile fw_profiles[];
extern const unsigned fw_profile_count;

typedef enum {
  FW_MATCH_EXACT = 0,   /* measured on this exact firmware build */
  FW_MATCH_FAMILY = 1,  /* audited family range with identical geometry */
  FW_MATCH_GUESS = 2,   /* unknown firmware: nearest older profile */
} fw_match;

/* Request-building strategy. */
typedef enum {
  REQ_AUTO = 0,
  REQ_PWS = 1,        /* ps5-web-stream's validated 0x2e0 record */
  REQ_NATIVE = 2,     /* firmware constructor constants + runtime fields */
  REQ_SYNTHETIC = 3,  /* only explicitly known fields */
} req_variant;

const fw_profile *fw_find_profile(uint32_t fw, fw_match *match);
/* SceAvCapture resolution enum for a capture height; -1 if unsupported. */
int fw_resolution_code(uint32_t fw, int height);
/* 1 when this firmware's resolution table lacks 1440p. */
int fw_legacy_resolutions(uint32_t fw);
const char *fw_variant_name(req_variant v);
req_variant fw_auto_variant(uint32_t fw, const fw_profile *p, fw_match match);

typedef struct {
  int width, height, fps, kbps;
  int resolution_code;
  int resource;     /* active ResourceArbitrator ID */
  int video_mode;   /* sceAvcap2GetVideoOutMode() result */
} req_params;

/* Build the OpenVideo record into out (capacity >= p->request_size).
 * Returns the record size or -1. */
int fw_build_request(uint8_t *out, size_t cap, const fw_profile *p,
                     req_variant v, const req_params *rp);

#endif
