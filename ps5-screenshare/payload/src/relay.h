/* PS5 Screen Share - connection to the relay (access from outside the home).
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The console dials out to the relay and keeps that connection open. When an
 * app asks for it, the relay sends OPEN <sid>; the console then dials a second
 * connection for that viewer and serves it over a sealed link. The console
 * never listens on the internet. See relay/PROTOCOL.md.
 */
#ifndef PS5SS_RELAY_H
#define PS5SS_RELAY_H

#include <stdint.h>

#include "wire.h"

typedef void (*relay_viewer_fn)(wire *w, const char *peer);

/* Starts the relay thread. secret: the 16-byte pairing secret. Returns 0 on success. */
int relay_start(const char *host, int port, const uint8_t secret[16], relay_viewer_fn fn);
/* 1 while the console is registered with the relay. */
int relay_connected(void);

/* Loads the pairing secret from path (32 hex characters). If the file is missing
 * it is created with 16 random bytes. created is set to 1 in that case. */
int pairing_load(const char *path, uint8_t secret[16], int *created);

#endif
