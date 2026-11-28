/* PS5 Screen Share - supervisor link.
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later */
#include "control.h"

#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int g_fd = -1;

int control_format_settings(char *out, size_t cap, const capture_settings *s) {
  return snprintf(out, cap, "W%d H%d F%d B%d A%d", s->width, s->height, s->fps,
                  s->kbps, s->audio);
}

int control_parse_settings(const char *text, capture_settings *s) {
  capture_settings t;
  if (sscanf(text, " W%d H%d F%d B%d A%d", &t.width, &t.height, &t.fps, &t.kbps,
             &t.audio) != 5 || !settings_valid(&t)) return -1;
  *s = t;
  return 0;
}

static int read_line(int fd, char *out, size_t cap, int timeout_ms) {
  size_t len = 0;
  while (len + 1 < cap) {
    struct pollfd p = {.fd = fd, .events = POLLIN};
    if (poll(&p, 1, timeout_ms) <= 0) return -1;
    ssize_t r = recv(fd, out + len, 1, 0);
    if (r <= 0) return -1;
    if (out[len] == '\n') { out[len] = 0; return 0; }
    len++;
  }
  return -1;
}

int control_connect(int port, unsigned *generation, capture_settings *s, int *have_settings) {
  *generation = 0;
  *have_settings = 0;
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  struct sockaddr_in a = {0};
  a.sin_family = AF_INET;
  a.sin_port = htons((uint16_t)(port + CONTROL_PORT_OFFSET));
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  char line[128];
  unsigned gen = 0;
  int consumed = 0;
  if (connect(fd, (struct sockaddr *)&a, sizeof(a)) ||
      read_line(fd, line, sizeof(line), 3000) ||
      sscanf(line, "G%u%n", &gen, &consumed) != 1 || !gen) {
    close(fd);
    return -1;
  }
  *generation = gen;
  if (!control_parse_settings(line + consumed, s)) *have_settings = 1;
  g_fd = fd;
  return 0;
}

int control_alive(void) {
  if (g_fd < 0) return 0;
  struct pollfd p = {.fd = g_fd, .events = POLLIN};
  if (poll(&p, 1, 0) <= 0) return 1;
  char c;
  ssize_t r = recv(g_fd, &c, 1, MSG_PEEK | MSG_DONTWAIT);
  if (r > 0) return 1;
  if (r < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) return 1;
  return 0;
}

int control_request_restart(const capture_settings *s) {
  if (g_fd < 0) return -1;
  char line[128] = "R ";
  int n = control_format_settings(line + 2, sizeof(line) - 3, s);
  if (n < 0) return -1;
  n += 2;
  line[n++] = '\n';
  return send(g_fd, line, (size_t)n, MSG_NOSIGNAL) == n ? 0 : -1;
}

int control_ask_existing_to_quit(int port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  struct sockaddr_in a = {0};
  a.sin_family = AF_INET;
  a.sin_port = htons((uint16_t)port);
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  int r = -1;
  if (!connect(fd, (struct sockaddr *)&a, sizeof(a)) &&
      send(fd, "QUIT\n", 5, MSG_NOSIGNAL) == 5) {
    char reply[8];
    if (!read_line(fd, reply, sizeof(reply), 3000) && !strcmp(reply, "BYE")) r = 0;
  }
  close(fd);
  return r;
}
