/* PS5 Screen Share - packet broadcaster with bounded per-client queues.
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The capture thread publishes each packet once; every connected client has
 * its own bounded queue and writer thread, so a slow phone never blocks the
 * capture loop. A client whose queue overflows is resynchronised at the next
 * IDR frame (and a new IDR is requested from the encoder).
 */
#ifndef PS5SS_STREAM_H
#define PS5SS_STREAM_H

#include <stddef.h>
#include <stdint.h>

#define STREAM_MAX_CLIENTS 4

typedef struct packet packet;
typedef struct client client;

/* Header + payload in one refcounted buffer. Payload is a then b. */
packet *packet_new(uint8_t type, uint8_t flags, uint64_t pts_us,
                   const void *a, size_t alen, const void *b, size_t blen);
void packet_unref(packet *p);
uint8_t packet_type(const packet *p);

void bc_init(void);
/* Register a connection; NULL when all slots are taken. */
client *bc_add(int fd, const char *peer, int want_audio);
/* Block in the calling thread, sending queued packets until the client is
 * closed or the socket fails. Returns when done (does not free). */
void bc_client_writer(client *c);
void bc_client_close(client *c);          /* wake writer, stop sending */
void bc_remove(client *c);                /* after writer returned */
void bc_client_set_audio(client *c, int want);
void bc_send_to(client *c, packet *p);    /* caller keeps its reference */

/* Publish to every client (takes ownership of the caller's reference). */
void bc_publish(packet *p);
/* Replace the INFO packet sent to every new client, and send it to all.
 * Takes ownership of the caller's reference (do not unref afterwards). */
void bc_set_info(packet *p);
void bc_status(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

int bc_client_count(void);
/* 1 if any client asked for an IDR since the last call. */
int bc_take_keyframe_request(void);
void bc_request_keyframe(void);
/* Copy a JSON array describing clients into out. */
size_t bc_describe(char *out, size_t cap);

#endif
