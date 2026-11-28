/* PS5 Screen Share - connection to the relay (see relay.h).
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "relay.h"

#include "log.h"
#include "platform.h"
#include "secure.h"

#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#define PING_EVERY_MS 20000
#define SILENT_AFTER_MS 60000
#define OPEN_TIMEOUT_MS 10000

static struct {
  char host[64];
  int port;
  uint8_t secret[PAIR_SECRET_LEN];
  uint8_t key[32];
  char id[PAIR_ID_LEN + 1];
  relay_viewer_fn fn;
} g;

static atomic_int g_registered;
static int g_started;

int relay_connected(void) { return atomic_load(&g_registered); }

static uint64_t now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint64_t)t.tv_sec * 1000u + (uint64_t)t.tv_nsec / 1000000u;
}

static int send_all(int fd, const char *p, size_t n) {
  while (n) {
    ssize_t r = send(fd, p, n, MSG_NOSIGNAL);
    if (r < 0 && errno == EINTR) continue;
    if (r <= 0) return -1;
    p += r;
    n -= (size_t)r;
  }
  return 0;
}

static int connect_relay(void) {
  struct addrinfo hints, *res = NULL;
  memset(&hints, 0, sizeof(hints));
  hints.ai_family = AF_INET;
  hints.ai_socktype = SOCK_STREAM;
  char port[8];
  snprintf(port, sizeof(port), "%d", g.port);
  if (getaddrinfo(g.host, port, &hints, &res) || !res) return -1;
  int fd = socket(res->ai_family, res->ai_socktype, 0);
  if (fd < 0) {
    freeaddrinfo(res);
    return -1;
  }
  struct timeval tv = {10, 0};
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
  int rc = connect(fd, res->ai_addr, res->ai_addrlen);
  freeaddrinfo(res);
  if (rc) {
    close(fd);
    return -1;
  }
  int one = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
  return fd;
}

/* Reads one line. Returns its length, -2 if nothing arrived within ms, -1 on error. */
static int read_line_wait(int fd, char *out, size_t cap, int ms) {
  size_t len = 0;
  for (;;) {
    struct pollfd p = {.fd = fd, .events = POLLIN};
    int n = poll(&p, 1, ms);
    if (n < 0 && errno == EINTR) continue;
    if (n == 0) return -2;
    if (n < 0) return -1;
    char ch;
    ssize_t r = recv(fd, &ch, 1, 0);
    if (r < 0 && errno == EINTR) continue;
    if (r <= 0) return -1;
    if (ch == '\n') break;
    if (ch == '\r') continue;
    if (len + 1 < cap) out[len++] = ch;
  }
  out[len] = 0;
  return (int)len;
}

static int random_bytes(uint8_t *out, size_t n) {
  int fd = open("/dev/urandom", O_RDONLY);
  if (fd < 0) return -1;
  size_t got = 0;
  while (got < n) {
    ssize_t r = read(fd, out + got, n - got);
    if (r < 0 && errno == EINTR) continue;
    if (r <= 0) break;
    got += (size_t)r;
  }
  close(fd);
  return got == n ? 0 : -1;
}

typedef struct {
  char sid[17];
  uint8_t key[32];
  relay_viewer_fn fn;
} viewer_job;

static void *viewer_main(void *arg) {
  viewer_job *j = arg;
  int fd = connect_relay();
  if (fd < 0) {
    LOG("relay: cannot open the tunnel for a viewer");
    goto done;
  }
  char line[96];
  snprintf(line, sizeof(line), "DATA %s\n", j->sid);
  uint8_t salt[16];
  if (send_all(fd, line, strlen(line)) || random_bytes(salt, sizeof(salt))) goto close_fd;
  char hex[64];
  size_t o = 0;
  memcpy(hex, "SALT ", 5);
  o = 5;
  for (int i = 0; i < 16; i++) {
    static const char H[] = "0123456789abcdef";
    hex[o++] = H[salt[i] >> 4];
    hex[o++] = H[salt[i] & 15];
  }
  hex[o++] = '\n';
  if (send_all(fd, hex, o)) goto close_fd;
  uint8_t sk[32];
  pair_session_key(j->key, salt, sk);
  wire *w = wire_secure(fd, sk, 'S', 'C');
  if (w) {
    char peer[32];
    snprintf(peer, sizeof(peer), "relay %.6s", j->sid);
    LOG("relay: viewer %s", peer);
    j->fn(w, peer);
    LOG("relay: viewer %s finished", peer);
    wire_free(w);
  }
  memset(sk, 0, sizeof(sk));
close_fd:
  shutdown(fd, SHUT_RDWR);
  close(fd);
done:
  memset(j->key, 0, sizeof(j->key));
  free(j);
  return NULL;
}

static void start_viewer(const char *sid) {
  viewer_job *j = calloc(1, sizeof(*j));
  if (!j) return;
  memcpy(j->sid, sid, 16); /* the caller checked the length */
  j->sid[16] = 0;
  memcpy(j->key, g.key, sizeof(j->key));
  j->fn = g.fn;
  if (platform_thread(NULL, viewer_main, j, 1)) {
    memset(j->key, 0, sizeof(j->key));
    free(j);
  }
}

static int register_with_relay(int fd) {
  char line[96];
  snprintf(line, sizeof(line), "PUB %s\n", g.id);
  if (send_all(fd, line, strlen(line))) return -1;
  if (read_line_wait(fd, line, sizeof(line), OPEN_TIMEOUT_MS) < 0 || strcmp(line, "OK")) return -1;
  return 0;
}

static void *relay_main(void *arg) {
  (void)arg;
  static int announced;
  for (;;) {
    int fd = connect_relay();
    if (fd < 0) {
      LOG("relay: cannot reach %s:%d; retrying", g.host, g.port);
      sleep(5);
      continue;
    }
    if (register_with_relay(fd)) {
      LOG("relay: registration refused by %s:%d; retrying", g.host, g.port);
      close(fd);
      sleep(5);
      continue;
    }
    atomic_store(&g_registered, 1);
    LOG("relay: registered with %s:%d (id %s)", g.host, g.port, g.id);
    if (!announced) {
      announced = 1;
      platform_notify("PS5 Screen Share: acesso pela internet ativo");
    }
    uint64_t last_rx = now_ms(), last_ping = now_ms();
    char line[96];
    for (;;) {
      int n = read_line_wait(fd, line, sizeof(line), 1000);
      uint64_t t = now_ms();
      if (n == -1) break;
      if (n >= 0) {
        last_rx = t;
        if (!strncmp(line, "OPEN ", 5) && strlen(line) == 5 + 16) start_viewer(line + 5);
      }
      if (t - last_rx > SILENT_AFTER_MS) {
        LOG("relay: silent for too long; reconnecting");
        break;
      }
      if (t - last_ping >= PING_EVERY_MS) {
        last_ping = t;
        if (send_all(fd, "PING\n", 5)) break;
      }
    }
    atomic_store(&g_registered, 0);
    shutdown(fd, SHUT_RDWR);
    close(fd);
    LOG("relay: connection lost; reconnecting in 3 s");
    sleep(3);
  }
  return NULL;
}

int relay_start(const char *host, int port, const uint8_t secret[16], relay_viewer_fn fn) {
  if (g_started || !host || !*host || port <= 0 || port > 65535 || !fn) return -1;
  snprintf(g.host, sizeof(g.host), "%s", host);
  g.port = port;
  memcpy(g.secret, secret, PAIR_SECRET_LEN);
  pair_key(g.secret, g.key);
  pair_id(g.secret, g.id);
  g.fn = fn;
  if (platform_thread(NULL, relay_main, NULL, 1)) return -1;
  g_started = 1;
  return 0;
}

int pairing_load(const char *path, uint8_t secret[16], int *created) {
  if (created) *created = 0;
  FILE *f = fopen(path, "r");
  if (f) {
    char text[128] = {0};
    size_t n = fread(text, 1, sizeof(text) - 1, f);
    fclose(f);
    text[n] = 0;
    if (!pair_parse(text, secret)) return 0;
    LOG("pairing: %s is not valid; replacing it", path);
  }
  if (random_bytes(secret, PAIR_SECRET_LEN)) return -1;
  char text[PAIR_TEXT_LEN];
  pair_format(secret, text);
  f = fopen(path, "w");
  if (!f) return -1;
  fprintf(f, "%s\n", text);
  fclose(f);
  if (created) *created = 1;
  return 0;
}
