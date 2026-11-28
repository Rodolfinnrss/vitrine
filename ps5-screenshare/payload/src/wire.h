/* PS5 Screen Share - a connection to one viewer: plain (LAN) or sealed (relay).
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Plain: bytes go straight to the socket, as on the LAN.
 * Sealed: every message is one frame, u32 big-endian length then the
 * ChaCha20-Poly1305 body (see secure.h and relay/PROTOCOL.md). Frames are
 * numbered per direction; a lost, repeated or reordered frame fails to open.
 */
#ifndef PS5SS_WIRE_H
#define PS5SS_WIRE_H

#include <stddef.h>
#include <stdint.h>

typedef struct wire wire;

wire *wire_plain(int fd);
/* key: the session key. send_dir / recv_dir: 'S' or 'C' (see relay/PROTOCOL.md). */
wire *wire_secure(int fd, const uint8_t key[32], uint8_t send_dir, uint8_t recv_dir);
void wire_free(wire *l);   /* does not close the socket */
int wire_fd(const wire *l);

/* Reads one line (without '\r' and '\n'). Returns its length, or -1 on error or end of stream. */
int wire_read_line(wire *l, char *out, size_t cap);
/* Sends a whole message. Returns 0 on success. Safe from more than one thread. */
int wire_send(wire *l, const void *data, size_t len);

#endif
