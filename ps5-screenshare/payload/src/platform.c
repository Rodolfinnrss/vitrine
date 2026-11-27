/* PS5 Screen Share - console services.
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later */
#include "platform.h"

#include "log.h"

#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int g_notify = 1;
void platform_notify_enable(int on) { g_notify = on; }

#ifdef PS5SS_HOST
uint32_t platform_fw_version(void) {
  const char *env = getenv("PS5SS_FAKE_FW");
  return env ? (uint32_t)strtoul(env, NULL, 0) : 0x12000043u;
}

void platform_notify(const char *fmt, ...) {
  char text[512];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(text, sizeof(text), fmt, ap);
  va_end(ap);
  LOG("notify: %s", text);
}
#else
#include <ps5/kernel.h>

typedef struct {
  char reserved[45];
  char message[3075];
} notify_request_t;

int sceKernelSendNotificationRequest(int, notify_request_t *, size_t, int);

uint32_t platform_fw_version(void) { return kernel_get_fw_version(); }

void platform_notify(const char *fmt, ...) {
  notify_request_t req;
  memset(&req, 0, sizeof(req));
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(req.message, sizeof(req.message), fmt, ap);
  va_end(ap);
  LOG("notify: %s", req.message);
  if (g_notify) sceKernelSendNotificationRequest(0, &req, sizeof(req), 0);
}
#endif

int platform_thread(pthread_t *out, void *(*fn)(void *), void *arg, int detached) {
  pthread_attr_t attr;
  pthread_t t;
  if (pthread_attr_init(&attr)) return -1;
  pthread_attr_setstacksize(&attr, 512 * 1024);
  if (detached) pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  int r = pthread_create(out ? out : &t, &attr, fn, arg);
  pthread_attr_destroy(&attr);
  return r;
}

static int route_ip(char *out, size_t cap) {
  /* The source address the kernel would use for a public route. */
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) return -1;
  struct sockaddr_in dst = {0};
  dst.sin_family = AF_INET;
  dst.sin_port = htons(53);
  dst.sin_addr.s_addr = htonl(0x08080808);
  struct sockaddr_in me = {0};
  socklen_t len = sizeof(me);
  int r = -1;
  if (!connect(fd, (struct sockaddr *)&dst, sizeof(dst)) &&
      !getsockname(fd, (struct sockaddr *)&me, &len) && me.sin_addr.s_addr &&
      inet_ntop(AF_INET, &me.sin_addr, out, (socklen_t)cap)) r = 0;
  close(fd);
  return r;
}

int platform_local_ip(char *out, size_t cap) {
  if (!route_ip(out, cap)) return 0;
  struct ifaddrs *list = NULL;
  int found = 0;
  if (!getifaddrs(&list)) {
    for (struct ifaddrs *i = list; i && !found; i = i->ifa_next) {
      if (!i->ifa_addr || i->ifa_addr->sa_family != AF_INET) continue;
      if (i->ifa_flags & IFF_LOOPBACK) continue;
      if (!(i->ifa_flags & IFF_UP)) continue;
      struct sockaddr_in *a = (struct sockaddr_in *)i->ifa_addr;
      if (inet_ntop(AF_INET, &a->sin_addr, out, (socklen_t)cap)) found = 1;
    }
    freeifaddrs(list);
  }
  return found ? 0 : -1;
}
