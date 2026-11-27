/* PS5 Screen Share - TCP stream/HTTP server and UDP discovery responder.
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later */
#include "server.h"

#include "log.h"
#include "pad.h"
#include "platform.h"
#include "protocol.h"
#include "settings.h"
#include "status.h"
#include "stream.h"

#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#ifdef PS5SS_APK_PATH
/* The Android app, served at /app.apk so the phone can install it directly. */
__asm__(".section .rodata\n"
        ".balign 16\n"
        ".global ps5ss_apk\n"
        "ps5ss_apk:\n"
        ".incbin \"" PS5SS_APK_PATH "\"\n"
        ".global ps5ss_apk_end\n"
        "ps5ss_apk_end:\n"
        ".byte 0\n"
        ".previous\n");
extern const unsigned char ps5ss_apk[], ps5ss_apk_end[];
#endif

static atomic_int g_quit;
static int g_port = PS5SS_DEFAULT_PORT;

int server_quit_requested(void) { return atomic_load(&g_quit); }

typedef struct {
  int fd;
  struct sockaddr_in peer;
} conn_arg;

static void set_timeout(int fd, int opt, int seconds) {
  struct timeval tv = {.tv_sec = seconds, .tv_usec = 0};
  setsockopt(fd, SOL_SOCKET, opt, &tv, sizeof(tv));
}

static int write_all(int fd, const void *data, size_t n) {
  const char *p = data;
  while (n) {
    ssize_t r = send(fd, p, n, MSG_NOSIGNAL);
    if (r < 0 && errno == EINTR) continue;
    if (r <= 0) return -1;
    p += r;
    n -= (size_t)r;
  }
  return 0;
}

/* Read one '\n' terminated line (without the newline). -1 on EOF/error. */
static int read_line(int fd, char *out, size_t cap) {
  size_t len = 0;
  for (;;) {
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

/* Sends PKT_PAD to one viewer when its availability changed. */
static void pad_reply(client *c, int *last, int state) {
  if (state == *last) return;
  *last = state;
  uint8_t b = (uint8_t)state;
  packet *p = packet_new(PKT_PAD, 0, 0, &b, 1, NULL, 0);
  bc_send_to(c, p);
  packet_unref(p);
}

static int is_loopback(const struct sockaddr_in *a) {
  return (ntohl(a->sin_addr.s_addr) >> 24) == 127;
}

/* ---------------------------------------------------------------- HTTP --- */

static void http_reply(int fd, const char *status, const char *type,
                       const char *extra, const void *body, size_t len, int head) {
  char hdr[512];
  int n = snprintf(hdr, sizeof(hdr),
                   "HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\n"
                   "Cache-Control: no-store\r\nConnection: close\r\n%s\r\n",
                   status, type, len, extra ? extra : "");
  if (write_all(fd, hdr, (size_t)n) == 0 && !head && len) write_all(fd, body, len);
}

static void http_index(int fd, int head) {
  service_status st;
  status_get(&st);
  capture_settings cs;
  settings_get(&cs);
  char ip[64] = "?";
  platform_local_ip(ip, sizeof(ip));
  char page[4096];
  int has_apk = 0;
#ifdef PS5SS_APK_PATH
  has_apk = 1;
#endif
  int n = snprintf(page, sizeof(page),
      "<!doctype html><html lang=pt-br><head><meta charset=utf-8>"
      "<meta name=viewport content='width=device-width,initial-scale=1'>"
      "<title>PS5 Screen Share</title><style>"
      "body{font-family:system-ui,sans-serif;background:#0b0f1a;color:#e8ecf4;margin:0;padding:24px;max-width:640px}"
      "a.btn{display:block;background:#2f6fec;color:#fff;text-decoration:none;padding:16px;border-radius:12px;"
      "text-align:center;font-size:18px;margin:16px 0}code{background:#1c2335;padding:2px 6px;border-radius:6px}"
      "td{padding:4px 12px 4px 0}</style></head><body>"
      "<h1>PS5 Screen Share</h1>"
      "<p>Endere&ccedil;o para o app: <code>%s:%d</code></p>"
      "%s"
      "<table><tr><td>Estado</td><td>%s</td></tr>"
      "<tr><td>Captura</td><td>%dx%d @ %d fps, %d kbps</td></tr>"
      "<tr><td>Pedido</td><td>%s @ %d fps, %d kbps</td></tr>"
      "<tr><td>Firmware</td><td>%x.%02x (%s)</td></tr>"
      "<tr><td>Quadros</td><td>%llu</td></tr></table>"
      "<p><a href=/status>/status</a> &middot; <a href=/log>/log</a></p>"
      "</body></html>",
      ip, g_port,
      has_apk ? "<a class=btn href=/app.apk>Baixar o app Android (APK)</a>" : "",
      st.state, st.width, st.height, st.fps, st.kbps,
      settings_resolution_name(cs.height), cs.fps, cs.kbps,
      (st.fw >> 24) & 0xff, (st.fw >> 16) & 0xff, st.profile,
      (unsigned long long)st.frames);
  if (n < 0) n = 0;
  if ((size_t)n >= sizeof(page)) n = sizeof(page) - 1;
  http_reply(fd, "200 OK", "text/html; charset=utf-8", NULL, page, (size_t)n, head);
}

static void handle_http(int fd) {
  char line[1024];
  if (read_line(fd, line, sizeof(line)) < 0) return;
  char method[8] = "", path[256] = "";
  sscanf(line, "%7s %255s", method, path);
  /* Drain headers. */
  char hdr[1024];
  for (int i = 0; i < 64; i++) {
    int n = read_line(fd, hdr, sizeof(hdr));
    if (n <= 0) break;
  }
  int head = !strcmp(method, "HEAD");
  char *q = strchr(path, '?');
  if (q) *q = 0;
  if (!strcmp(path, "/") || !strcmp(path, "/index.html")) {
    http_index(fd, head);
  } else if (!strcmp(path, "/status")) {
    char *json = malloc(8192);
    if (!json) return;
    size_t n = status_json(json, 8192, g_port);
    http_reply(fd, "200 OK", "application/json", "Access-Control-Allow-Origin: *\r\n",
               json, n, head);
    free(json);
  } else if (!strcmp(path, "/log")) {
    char *text = malloc(64 * 1024 + 1);
    if (!text) return;
    size_t n = log_snapshot(text, 64 * 1024 + 1);
    http_reply(fd, "200 OK", "text/plain; charset=utf-8", NULL, text, n, head);
    free(text);
#ifdef PS5SS_APK_PATH
  } else if (!strcmp(path, "/app.apk") || !strcmp(path, "/ps5-screenshare.apk")) {
    http_reply(fd, "200 OK", "application/vnd.android.package-archive",
               "Content-Disposition: attachment; filename=\"ps5-screenshare.apk\"\r\n",
               ps5ss_apk, (size_t)(ps5ss_apk_end - ps5ss_apk), head);
#endif
  } else {
    static const char nf[] = "not found\n";
    http_reply(fd, "404 Not Found", "text/plain", NULL, nf, sizeof(nf) - 1, head);
  }
}

/* -------------------------------------------------------------- stream --- */

static int parse_audio_flag(const char *line, int def) {
  const char *a = strstr(line, "audio=");
  if (!a) return def;
  return a[6] != '0';
}

static void send_full_and_close(int fd) {
  uint8_t hello[8] = {'P', 'S', '5', 'S', 0, PS5SS_PROTO_VERSION, 0, 0};
  write_all(fd, hello, sizeof(hello));
  const char *msg = "Servidor cheio: muitos clientes conectados";
  size_t len = strlen(msg);
  uint8_t h[PS5SS_HEADER_LEN] = {PKT_STATUS, 0, 0, 0,
                                 (uint8_t)(len >> 24), (uint8_t)(len >> 16),
                                 (uint8_t)(len >> 8), (uint8_t)len};
  write_all(fd, h, sizeof(h));
  write_all(fd, msg, len);
}

typedef struct {
  client *c;
} writer_arg;

static void *writer_main(void *arg) {
  bc_client_writer(((writer_arg *)arg)->c);
  return NULL;
}

static void handle_stream(int fd, const struct sockaddr_in *peer_addr) {
  char peer[64];
  char ipbuf[INET_ADDRSTRLEN] = "?";
  inet_ntop(AF_INET, &peer_addr->sin_addr, ipbuf, sizeof(ipbuf));
  snprintf(peer, sizeof(peer), "%s:%u", ipbuf, ntohs(peer_addr->sin_port));

  char line[256];
  if (read_line(fd, line, sizeof(line)) < 0) return;
  if (!strcmp(line, "QUIT")) {
    if (is_loopback(peer_addr)) {
      LOG("server: QUIT from %s (a new copy is starting)", peer);
      atomic_store(&g_quit, 1);
      write_all(fd, "BYE\n", 4);
    }
    return;
  }
  if (strncmp(line, "HELLO", 5)) {
    LOG("server: unexpected greeting from %s", peer);
    return;
  }
  int want_audio = parse_audio_flag(line, 1);
  int changed = settings_apply_tokens(line + 5);
  if (changed > 0) LOG("server: %s requested new capture settings: %s", peer, line);
  else if (changed < 0) LOG("server: %s sent invalid settings: %s", peer, line);

  int one = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
  int sndbuf = 1024 * 1024;
  setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &sndbuf, sizeof(sndbuf));
  set_timeout(fd, SO_RCVTIMEO, 0);
  set_timeout(fd, SO_SNDTIMEO, 10);

  client *c = bc_add(fd, peer, want_audio);
  if (!c) {
    LOG("server: refusing %s, %d clients connected", peer, STREAM_MAX_CLIENTS);
    send_full_and_close(fd);
    close(fd);
    return;
  }
  LOG("server: client %s connected (audio=%d)", peer, want_audio);
  platform_notify("PS5 Screen Share: celular conectado (%s)", ipbuf);

  pthread_t writer;
  writer_arg wa = {c};
  if (platform_thread(&writer, writer_main, &wa, 0)) {
    bc_client_close(c);
    bc_remove(c);
    return;
  }
  if (changed < 0) {
    static const char bad[] = "Configuracao invalida ignorada";
    packet *p = packet_new(PKT_STATUS, 0, 0, bad, sizeof(bad) - 1, NULL, 0);
    bc_send_to(c, p);
    packet_unref(p);
  }
  int last_pad = -1;
  pad_reply(c, &last_pad, pad_state_for(c));
  while (read_line(fd, line, sizeof(line)) >= 0) {
    if (!strcmp(line, "KEY")) {
      bc_request_keyframe();
    } else if (!strncmp(line, "AUDIO", 5)) {
      bc_client_set_audio(c, atoi(line + 5) != 0);
    } else if (!strncmp(line, "PING", 4)) {
      const char *token = line[4] == ' ' ? line + 5 : "";
      packet *p = packet_new(PKT_PONG, 0, 0, token, strlen(token), NULL, 0);
      bc_send_to(c, p);
      packet_unref(p);
    } else if (!strncmp(line, "SET", 3)) {
      int r = settings_apply_tokens(line + 3);
      LOG("server: %s SET %s -> %d", peer, line + 3, r);
    } else if (!strncmp(line, "PAD ", 4)) {
      uint32_t seq;
      pad_state state;
      if (pad_parse(line + 4, &seq, &state)) {
        LOG("server: %s sent a malformed PAD line", peer);
      } else {
        pad_reply(c, &last_pad, pad_submit(c, seq, &state));
      }
    } else if (!strcmp(line, "PADRELEASE")) {
      pad_release(c);
      pad_reply(c, &last_pad, pad_state_for(c));
    } else if (!strcmp(line, "PADSTATE")) {
      last_pad = -1; /* always answer, even when unchanged */
      pad_reply(c, &last_pad, pad_state_for(c));
    } else if (!strcmp(line, "BYE")) {
      break;
    }
  }
  pad_release(c);
  bc_client_close(c);
  pthread_join(writer, NULL);
  bc_remove(c);
  LOG("server: client %s disconnected", peer);
}

static void *conn_main(void *arg) {
  conn_arg *ca = arg;
  int fd = ca->fd;
  struct sockaddr_in peer = ca->peer;
  free(ca);
  set_timeout(fd, SO_RCVTIMEO, 5);
  char probe[4];
  size_t got = 0;
  while (got < sizeof(probe)) {
    ssize_t r = recv(fd, probe, sizeof(probe), MSG_PEEK);
    if (r < 0 && errno == EINTR) continue;
    if (r <= 0) break;
    got = (size_t)r;
    if (got < sizeof(probe)) usleep(10000);
  }
  if (got == sizeof(probe)) {
    if (!memcmp(probe, "GET ", 4) || !memcmp(probe, "HEAD", 4)) {
      handle_http(fd);
    } else if (!memcmp(probe, "HELL", 4) || !memcmp(probe, "QUIT", 4)) {
      handle_stream(fd, &peer);
      /* handle_stream closes stream clients through bc_remove */
      return NULL;
    }
  }
  close(fd);
  return NULL;
}

typedef struct {
  int fd;
} accept_arg;

static void *accept_main(void *arg) {
  int lfd = ((accept_arg *)arg)->fd;
  free(arg);
  for (;;) {
    conn_arg *ca = calloc(1, sizeof(*ca));
    if (!ca) { sleep(1); continue; }
    socklen_t len = sizeof(ca->peer);
    ca->fd = accept(lfd, (struct sockaddr *)&ca->peer, &len);
    if (ca->fd < 0) {
      free(ca);
      if (errno == EINTR || errno == ECONNABORTED) continue;
      LOG("server: accept failed: %s", strerror(errno));
      sleep(1);
      continue;
    }
    if (platform_thread(NULL, conn_main, ca, 1)) {
      close(ca->fd);
      free(ca);
    }
  }
  return NULL;
}

int server_listen(int port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -errno;
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
  struct sockaddr_in a = {0};
  a.sin_family = AF_INET;
  a.sin_port = htons((uint16_t)port);
  a.sin_addr.s_addr = htonl(INADDR_ANY);
  if (bind(fd, (struct sockaddr *)&a, sizeof(a)) || listen(fd, 16)) {
    int e = errno;
    close(fd);
    return -e;
  }
  return fd;
}

int server_start(int listen_fd, int port) {
  g_port = port;
  accept_arg *a = malloc(sizeof(*a));
  if (!a) return -1;
  a->fd = listen_fd;
  if (platform_thread(NULL, accept_main, a, 1)) { free(a); return -1; }
  return 0;
}

/* ----------------------------------------------------------- discovery --- */

static void *discovery_main(void *arg) {
  int fd = (int)(intptr_t)arg;
  char buf[256];
  for (;;) {
    struct sockaddr_in from;
    socklen_t len = sizeof(from);
    ssize_t n = recvfrom(fd, buf, sizeof(buf) - 1, 0, (struct sockaddr *)&from, &len);
    if (n < 0) {
      if (errno == EINTR) continue;
      sleep(1);
      continue;
    }
    buf[n] = 0;
    if (strncmp(buf, PS5SS_DISCOVERY_QUERY, strlen(PS5SS_DISCOVERY_QUERY))) continue;
    service_status st;
    status_get(&st);
    char ip[64] = "";
    platform_local_ip(ip, sizeof(ip));
    char reply[512];
    int m = snprintf(reply, sizeof(reply),
        PS5SS_DISCOVERY_REPLY "{\"app\":\"ps5-screenshare\",\"protocol\":%d,\"port\":%d,"
        "\"ip\":\"%s\",\"firmware\":\"%x.%02x\",\"clients\":%d,\"width\":%d,\"height\":%d}",
        PS5SS_PROTO_VERSION, g_port, ip, (st.fw >> 24) & 0xff, (st.fw >> 16) & 0xff,
        bc_client_count(), st.width, st.height);
    if (m > 0) sendto(fd, reply, (size_t)m, 0, (struct sockaddr *)&from, len);
  }
  return NULL;
}

int discovery_start(int port) {
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) return -1;
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
  setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &one, sizeof(one));
  struct sockaddr_in a = {0};
  a.sin_family = AF_INET;
  a.sin_port = htons((uint16_t)port);
  a.sin_addr.s_addr = htonl(INADDR_ANY);
  if (bind(fd, (struct sockaddr *)&a, sizeof(a))) {
    LOG("discovery: bind udp %d failed: %s", port, strerror(errno));
    close(fd);
    return -1;
  }
  if (platform_thread(NULL, discovery_main, (void *)(intptr_t)fd, 1)) {
    close(fd);
    return -1;
  }
  return 0;
}
