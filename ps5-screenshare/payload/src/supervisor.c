/* PS5 Screen Share - supervisor: the ELF you send to the console.
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Starts the embedded capture service through the ELF loader and starts a
 * fresh copy whenever the service asks for one (see control.h). Sending this
 * ELF again replaces a running copy: the old service is asked to quit, which
 * also ends the old supervisor.
 */
#include "config.h"
#include "control.h"
#include "log.h"
#include "platform.h"

#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#ifndef ELFLDR_PORT
#define ELFLDR_PORT 9021
#endif

__asm__(".section .rodata\n"
        ".balign 16\n"
        ".global ps5ss_service_elf\n"
        "ps5ss_service_elf:\n"
        ".incbin \"" PS5SS_SERVICE_PATH "\"\n"
        ".global ps5ss_service_elf_end\n"
        "ps5ss_service_elf_end:\n"
        ".byte 0\n"
        ".previous\n");
extern const unsigned char ps5ss_service_elf[], ps5ss_service_elf_end[];

static int loopback_socket(int port, struct sockaddr_in *a) {
  memset(a, 0, sizeof(*a));
  a->sin_family = AF_INET;
  a->sin_port = htons((uint16_t)port);
  a->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  return socket(AF_INET, SOCK_STREAM, 0);
}

/* Hand the service ELF to the loader, which runs it as a new process. */
static int launch(void) {
  struct sockaddr_in a;
  int fd = loopback_socket(ELFLDR_PORT, &a);
  if (fd < 0) return -1;
  if (connect(fd, (struct sockaddr *)&a, sizeof(a))) { close(fd); return -1; }
  const unsigned char *p = ps5ss_service_elf;
  size_t left = (size_t)(ps5ss_service_elf_end - ps5ss_service_elf);
  while (left) {
    ssize_t n = send(fd, p, left, MSG_NOSIGNAL);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) { close(fd); return -1; }
    p += n;
    left -= (size_t)n;
  }
  shutdown(fd, SHUT_WR);
  /* Give the loader a moment to consume the ELF. Some loaders stream the
   * payload's stdout back on this socket, so do not wait for EOF. */
  struct pollfd pf = {.fd = fd, .events = POLLIN};
  char sink[256];
  if (poll(&pf, 1, 500) == 1) (void)recv(fd, sink, sizeof(sink), MSG_DONTWAIT);
  close(fd);
  return 0;
}

static int bind_control(int port) {
  struct sockaddr_in a;
  int fd = loopback_socket(port + CONTROL_PORT_OFFSET, &a);
  if (fd < 0) return -1;
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
  if (bind(fd, (struct sockaddr *)&a, sizeof(a)) || listen(fd, 1)) {
    close(fd);
    return -1;
  }
  return fd;
}

int main(void) {
  signal(SIGPIPE, SIG_IGN);
  setvbuf(stdout, NULL, _IONBF, 0);
  log_init("ps5ss-sup", "supervisor.txt");
  ps5ss_config cfg;
  config_defaults(&cfg);
  config_load_file(&cfg);
  platform_notify_enable(cfg.notify);
  LOG("supervisor: pid %d, service %zu bytes, port %d", (int)getpid(),
      (size_t)(ps5ss_service_elf_end - ps5ss_service_elf), cfg.port);

  int listener = bind_control(cfg.port);
  if (listener < 0) {
    /* Another copy is running: ask its service to quit; its supervisor
     * exits when the service does. */
    LOG("supervisor: another copy is running; replacing it");
    control_ask_existing_to_quit(cfg.port);
    for (int i = 0; i < 40 && listener < 0; i++) {
      usleep(250000);
      listener = bind_control(cfg.port);
    }
  }
  if (listener < 0) {
    LOG("supervisor: control port %d unavailable", cfg.port + CONTROL_PORT_OFFSET);
    platform_notify("PS5 Screen Share: nao foi possivel substituir a copia em execucao");
    return 1;
  }

  capture_settings settings;
  int have_settings = 0;
  for (unsigned generation = 1;; generation++) {
    int launched = -1;
    for (int attempt = 0; attempt < 5 && launched; attempt++) {
      if (attempt) sleep(2);
      launched = launch();
    }
    if (launched) {
      LOG("supervisor: ELF loader not reachable on 127.0.0.1:%d", ELFLDR_PORT);
      platform_notify("PS5 Screen Share: ELF loader na porta %d nao encontrado. "
                      "Envie ps5-screenshare-service.elf diretamente.", ELFLDR_PORT);
      return 1;
    }
    struct pollfd p = {.fd = listener, .events = POLLIN};
    int fd = poll(&p, 1, 30000) == 1 ? accept(listener, NULL, NULL) : -1;
    if (fd < 0) {
      LOG("supervisor: service #%u did not connect; exiting", generation);
      return 1;
    }
    char line[128];
    int n = snprintf(line, sizeof(line), "G%u ", generation);
    if (have_settings) n += control_format_settings(line + n, sizeof(line) - (size_t)n - 1, &settings);
    line[n++] = '\n';
    send(fd, line, (size_t)n, MSG_NOSIGNAL);
    LOG("supervisor: service #%u running", generation);

    int restart = 0;
    size_t len = 0;
    for (;;) {
      char c;
      ssize_t r = recv(fd, &c, 1, 0);
      if (r < 0 && errno == EINTR) continue;
      if (r <= 0) break;
      if (len + 1 < sizeof(line)) line[len++] = c;
      if (c == '\n') {
        line[len] = 0;
        len = 0;
        if (line[0] == 'R') {
          restart = 1;
          have_settings = !control_parse_settings(line + 1, &settings);
        }
      }
    }
    close(fd);
    if (!restart) {
      LOG("supervisor: service #%u exited; stopping", generation);
      return 0;
    }
    LOG("supervisor: service #%u asked for a fresh process", generation);
    sleep(1); /* let the old process release its ports and capture */
  }
}
