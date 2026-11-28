/* PS5 Screen Share - logging (stdout/klog, in-memory ring, file).
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later */
#ifndef PS5SS_LOG_H
#define PS5SS_LOG_H

#include <stddef.h>

#ifndef PS5SS_DATA_DIR
#define PS5SS_DATA_DIR "/data/ps5-screenshare"
#endif

/* filename is created inside PS5SS_DATA_DIR; the previous one is kept as .1 */
void log_init(const char *tag, const char *filename);
void LOG(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
/* Copy the most recent log text into out (NUL terminated); returns length. */
size_t log_snapshot(char *out, size_t cap);

#endif
