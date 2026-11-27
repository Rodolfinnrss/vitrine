/* PS5 Screen Share - TCP stream/HTTP server and UDP discovery responder.
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later */
#ifndef PS5SS_SERVER_H
#define PS5SS_SERVER_H

#include "wire.h"

/* Bind the TCP listener. Returns the listening fd or a negative errno. */
int server_listen(int port);
/* Start the accept thread on a listener from server_listen. */
int server_start(int listen_fd, int port);
/* Start the UDP discovery responder on the same port number. */
int discovery_start(int port);
/* Serves a viewer that arrived through the relay on a sealed connection. */
void server_serve_relay(wire *w, const char *peer);
/* The pairing code shown on the home page (LAN only). */
void server_set_pairing(const char *text);
/* 1 once a loopback client sent QUIT (a newer copy is starting). */
int server_quit_requested(void);

#endif
