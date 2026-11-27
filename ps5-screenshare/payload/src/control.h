/* PS5 Screen Share - link between the capture service and its supervisor.
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The console keeps capture state per process: after the video-out mode
 * changes (a game starts or quits) OpenVideo can keep failing in the same
 * process while a fresh process opens at once (observed by ps5-web-stream).
 * The deployed ELF is therefore a small supervisor that embeds the service
 * ELF and starts it through the ELF loader (127.0.0.1:9021). The service
 * connects back on 127.0.0.1:(port + 1000). When it gets stuck it sends a
 * restart request with its settings and exits; the supervisor launches a
 * fresh copy. Each side exits when the other's connection closes.
 *
 *   supervisor -> service  "G<generation> W<w> H<h> F<fps> B<kbps> A<audio>\n"
 *   service -> supervisor  "R W<w> H<h> F<fps> B<kbps> A<audio>\n"
 */
#ifndef PS5SS_CONTROL_H
#define PS5SS_CONTROL_H

#include <stddef.h>

#include "settings.h"

#define CONTROL_PORT_OFFSET 1000

int control_connect(int port, unsigned *generation, capture_settings *s, int *have_settings);
int control_alive(void);
int control_request_restart(const capture_settings *s);

/* Ask an already running service on 127.0.0.1:port to exit (it answers BYE).
 * Returns 0 if it accepted. */
int control_ask_existing_to_quit(int port);

int control_format_settings(char *out, size_t cap, const capture_settings *s);
int control_parse_settings(const char *text, capture_settings *s);

#endif
