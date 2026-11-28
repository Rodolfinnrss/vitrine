/* PS5 Screen Share - plain and sealed connections (see link.h).
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "wire.h"

#include "secure.h"

#include <errno.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>

struct wire {
  int fd, secure;
  uint8_t key[32];
  uint8_t send_dir, recv_dir;
  uint64_t send_seq, recv_seq;
  pthread_mutex_t tx;
  uint8_t *buf;     /* scratch for frames, grown on demand */
  size_t cap;
};

static int send_all(int fd, const uint8_t *p, size_t n) {
  while (n) {
    ssize_t r = send(fd, p, n, MSG_NOSIGNAL);
    if (r < 0 && errno == EINTR) continue;
    if (r <= 0) return -1;
    p += r;
    n -= (size_t)r;
  }
  return 0;
}

static int recv_exact(int fd, uint8_t *p, size_t n) {
  while (n) {
    ssize_t r = recv(fd, p, n, 0);
    if (r < 0 && errno == EINTR) continue;
    if (r <= 0) return -1;
    p += r;
    n -= (size_t)r;
  }
  return 0;
}

static wire *make(int fd, int secure) {
  wire *l = calloc(1, sizeof(*l));
  if (!l) return NULL;
  l->fd = fd;
  l->secure = secure;
  pthread_mutex_init(&l->tx, NULL);
  return l;
}

wire *wire_plain(int fd) { return make(fd, 0); }

wire *wire_secure(int fd, const uint8_t key[32], uint8_t send_dir, uint8_t recv_dir) {
  wire *l = make(fd, 1);
  if (!l) return NULL;
  memcpy(l->key, key, 32);
  l->send_dir = send_dir;
  l->recv_dir = recv_dir;
  return l;
}

void wire_free(wire *l) {
  if (!l) return;
  pthread_mutex_destroy(&l->tx);
  free(l->buf);
  memset(l->key, 0, sizeof(l->key));
  free(l);
}

int wire_fd(const wire *l) { return l ? l->fd : -1; }

static int ensure(wire *l, size_t n) {
  if (n <= l->cap) return 0;
  uint8_t *b = realloc(l->buf, n);
  if (!b) return -1;
  l->buf = b;
  l->cap = n;
  return 0;
}

int wire_read_line(wire *l, char *out, size_t cap) {
  if (!l || !out || !cap) return -1;
  size_t len = 0;
  if (!l->secure) {
    for (;;) {
      char ch;
      ssize_t r = recv(l->fd, &ch, 1, 0);
      if (r < 0 && errno == EINTR) continue;
      if (r <= 0) return -1;
      if (ch == '\n') break;
      if (ch == '\r') continue;
      if (len + 1 < cap) out[len++] = ch;
    }
    out[len] = 0;
    return (int)len;
  }
  uint8_t head[4];
  if (recv_exact(l->fd, head, 4)) return -1;
  uint32_t body = ((uint32_t)head[0] << 24) | ((uint32_t)head[1] << 16) |
                  ((uint32_t)head[2] << 8) | head[3];
  if (body < SECURE_TAG_LEN || body > SECURE_MAX_PLAIN + SECURE_TAG_LEN) return -1;
  if (ensure(l, body)) return -1;
  if (recv_exact(l->fd, l->buf, body)) return -1;
  uint8_t nonce[12];
  frame_nonce(l->recv_dir, l->recv_seq, nonce);
  if (aead_open(l->key, nonce, l->buf, body, l->buf)) return -1;
  l->recv_seq++;
  size_t plain = body - SECURE_TAG_LEN;
  while (len < plain && len + 1 < cap && l->buf[len] != '\n') {
    out[len] = (char)l->buf[len];
    len++;
  }
  while (len && (out[len - 1] == '\r')) len--;
  out[len] = 0;
  return (int)len;
}

int wire_send(wire *l, const void *data, size_t len) {
  if (!l) return -1;
  if (!l->secure) return send_all(l->fd, data, len);
  if (len > SECURE_MAX_PLAIN) return -1;
  pthread_mutex_lock(&l->tx);
  int rc = -1;
  size_t body = len + SECURE_TAG_LEN;
  if (ensure(l, 4 + body) == 0) {
    l->buf[0] = (uint8_t)(body >> 24);
    l->buf[1] = (uint8_t)(body >> 16);
    l->buf[2] = (uint8_t)(body >> 8);
    l->buf[3] = (uint8_t)body;
    uint8_t nonce[12];
    frame_nonce(l->send_dir, l->send_seq, nonce);
    aead_seal(l->key, nonce, data, len, l->buf + 4);
    if (send_all(l->fd, l->buf, 4 + body) == 0) {
      l->send_seq++;
      rc = 0;
    }
  }
  pthread_mutex_unlock(&l->tx);
  return rc;
}
