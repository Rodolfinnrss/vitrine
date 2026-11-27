/* PS5 Screen Share - console services (firmware id, notifications, IP).
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later */
#ifndef PS5SS_PLATFORM_H
#define PS5SS_PLATFORM_H

#include <stddef.h>
#include <stdint.h>

uint32_t platform_fw_version(void);
/* Enable/disable console toasts (they are always logged). */
void platform_notify_enable(int on);
/* System toast on the console (logged only on the host build). */
void platform_notify(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
/* Best local IPv4 address as text; returns 0 on success. */
int platform_local_ip(char *out, size_t cap);

/* Start a thread with a known stack size (the console's default is small).
 * detached: no join needed. Returns 0 on success. */
#include <pthread.h>
int platform_thread(pthread_t *out, void *(*fn)(void *), void *arg, int detached);

#endif
