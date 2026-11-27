/* PS5 Screen Share - virtual controller driven by the viewer's touches.
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Button bits follow the Sony pad layout used by PBS-Payload
 * (https://github.com/the-mentor/PBS-Payload, GPL-3.0-or-later).
 */
#ifndef PS5SS_PAD_H
#define PS5SS_PAD_H

#include <stdint.h>

#define PAD_L3 0x00000002u
#define PAD_R3 0x00000004u
#define PAD_OPTIONS 0x00000008u
#define PAD_UP 0x00000010u
#define PAD_RIGHT 0x00000020u
#define PAD_DOWN 0x00000040u
#define PAD_LEFT 0x00000080u
#define PAD_L2 0x00000100u
#define PAD_R2 0x00000200u
#define PAD_L1 0x00000400u
#define PAD_R1 0x00000800u
#define PAD_TRIANGLE 0x00001000u
#define PAD_CIRCLE 0x00002000u
#define PAD_CROSS 0x00004000u
#define PAD_SQUARE 0x00008000u
#define PAD_PS 0x00010000u
#define PAD_TOUCHPAD 0x00100000u
/* Bits the protocol accepts. Anything else is rejected as malformed. */
#define PAD_VALID_BITS 0x0013fffeu

typedef struct {
  uint32_t buttons;
  uint8_t lx, ly, rx, ry, l2, r2;
} pad_state;

/* Viewer-facing availability, sent to each client as a PKT_PAD byte. */
enum {
  PAD_UNAVAILABLE = 0, /* no virtual controller on this console or disabled */
  PAD_FREE = 1,        /* available, nobody controls it */
  PAD_YOURS = 2,       /* this viewer controls it */
  PAD_BUSY = 3,        /* another viewer controls it */
};

/* Brings up the virtual controller (or none, when enabled is 0). Returns 0 if
 * it is usable. Call once, before the server starts accepting viewers. */
int pad_init(int enabled);
/* Neutral input, device removal, thread join. Call when the service exits. */
void pad_shutdown(void);

/* Takes control for owner if nobody has it, then applies the state when owner
 * is the controller's owner. Returns PAD_YOURS, PAD_BUSY or PAD_UNAVAILABLE. */
int pad_submit(const void *owner, uint32_t seq, const pad_state *state);
/* Availability as seen by owner. */
int pad_state_for(const void *owner);
/* Gives the controller up if owner has it. Safe to call for anyone. */
void pad_release(const void *owner);

/* "seq,buttons,lx,ly,rx,ry,l2,r2" (decimal). Returns 0 on success. */
int pad_parse(const char *text, uint32_t *seq, pad_state *state);

typedef struct {
  int available;
  int owned;
  uint64_t writes;
  uint32_t buttons;
} pad_info;
void pad_get_info(pad_info *out);

#endif
