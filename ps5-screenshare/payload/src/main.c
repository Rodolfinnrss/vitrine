/* PS5 Screen Share - capture service: hardware H.264 capture of the PS5
 * screen (plus system audio) streamed to the Android app over the LAN.
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "audio.h"
#include "avcap.h"
#include "config.h"
#include "control.h"
#include "log.h"
#include "pad.h"
#include "platform.h"
#include "relay.h"
#include "secure.h"
#include "protocol.h"
#include "server.h"
#include "settings.h"
#include "status.h"
#include "stream.h"

#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#ifndef PS5SS_VERSION
#define PS5SS_VERSION "dev"
#endif

#define VIDBUF_SZ (4 * 1024 * 1024)
#define STALL_MS 8000
#define OPEN_FAILURES_BEFORE_RESTART 2
#define AVCAP_SESSION_LOST ((int)0x81950009)
#define AVCAP_INVALID ((int)0x81950001)

static volatile sig_atomic_t g_stop;
static int g_supervised;
static ps5ss_config g_cfg;

static void on_signal(int sig) { (void)sig; g_stop = 1; }

static uint64_t now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint64_t)t.tv_sec * 1000 + (uint64_t)t.tv_nsec / 1000000;
}

/* Stop conditions shared by every wait. */
static int should_stop(void) {
  static uint64_t checked;
  if (g_stop) return 1;
  if (server_quit_requested()) { g_stop = 1; return 1; }
  uint64_t t = now_ms();
  if (g_supervised && t - checked >= 1000) {
    checked = t;
    if (!control_alive()) {
      LOG("main: supervisor is gone; exiting");
      g_stop = 1;
      return 1;
    }
  }
  return 0;
}

/* Sleep up to ms; returns early (1) on stop. */
static int wait_ms(unsigned ms) {
  uint64_t end = now_ms() + ms;
  while (now_ms() < end) {
    if (should_stop()) return 1;
    usleep(50000);
  }
  return should_stop();
}

#define NOTIFY(...) platform_notify(__VA_ARGS__)

static void publish_info(const capture_settings *cs, int audio, unsigned generation) {
  uint32_t fw = platform_fw_version();
  char json[640];
  int n = snprintf(json, sizeof(json),
      "{\"codec\":\"h264\",\"width\":%d,\"height\":%d,\"fps\":%d,\"kbps\":%d,"
      "\"audio\":%d,\"sample_rate\":%d,\"channels\":%d,\"format\":\"s16le\","
      "\"firmware\":\"%x.%02x\",\"profile\":\"%s\",\"generation\":%u,"
      "\"version\":\"%s\"}",
      cs->width, cs->height, cs->fps, cs->kbps, audio, AUDIO_SAMPLE_RATE,
      AUDIO_CHANNELS, (fw >> 24) & 0xff, (fw >> 16) & 0xff, avcap_profile_desc(),
      generation, PS5SS_VERSION);
  if (n < 0) return;
  if ((size_t)n >= sizeof(json)) n = sizeof(json) - 1;
  /* bc_set_info takes ownership of the new packet. */
  bc_set_info(packet_new(PKT_INFO, 0, 0, json, (size_t)n, NULL, 0));
}

static req_variant alternate_variant(req_variant v, uint32_t fw) {
  fw_match m;
  const fw_profile *p = fw_find_profile(fw, &m);
  if (v == REQ_AUTO) v = fw_auto_variant(fw, p, m);
  switch (v) {
    case REQ_PWS: return REQ_NATIVE;
    case REQ_NATIVE: return REQ_SYNTHETIC;
    default: return p && p->request_size == 0x2e0 ? REQ_PWS : REQ_NATIVE;
  }
}

/* Capture until a reason to stop: returns 1 settings changed, 2 idle,
 * 0 stop requested, negative SCE error. */
static int stream_session(const capture_settings *cs, unsigned revision, uint8_t *vbuf,
                          unsigned generation) {
  audio_capture *audio = cs->audio ? audio_capture_open(avcap_resource_id()) : NULL;
  if (cs->audio && !audio) {
    LOG("main: audio capture unavailable; streaming video only");
    bc_status("Audio indisponivel neste console; transmitindo somente video");
  }
  status_set_capture(cs->width, cs->height, cs->fps, cs->kbps, audio != NULL);
  status_set_state("transmitindo %dx%d @ %d fps", cs->width, cs->height, cs->fps);
  publish_info(cs, audio != NULL, generation);
  bc_status("Transmitindo %dx%d @ %d fps, %d kbps", cs->width, cs->height, cs->fps, cs->kbps);
  bc_request_keyframe();

  int16_t pcm[AUDIO_FRAME_SAMPLES * AUDIO_CHANNELS];
  uint64_t last_video = now_ms(), idle_since = 0, frames = 0, last_report = now_ms();
  uint64_t bytes = 0;
  int result = 0;
  while (!should_stop()) {
    capture_settings cur;
    if (settings_get(&cur) != revision) { result = 1; break; }
    uint64_t t = now_ms();
    if (bc_client_count() == 0) {
      if (!idle_since) idle_since = t;
      if (t - idle_since >= (uint64_t)g_cfg.idle_timeout * 1000) { result = 2; break; }
    } else {
      idle_since = 0;
    }
    if (bc_take_keyframe_request()) avcap_request_keyframe();

    int activity = 0;
    avcap_frame fr;
    int r = avcap_read_video(vbuf, VIDBUF_SZ, &fr);
    if (r < 0) {
      LOG("main: video read failed 0x%08x", (unsigned)r);
      result = r;
      break;
    }
    if (r > 0) {
      activity = 1;
      last_video = t;
      frames++;
      bytes += fr.len;
      status_count_frame(fr.len, fr.keyframe);
      bc_publish(packet_new(PKT_VIDEO, fr.keyframe ? PKT_FLAG_KEYFRAME : 0, fr.pts_us,
                            vbuf, fr.len, NULL, 0));
    } else if (t - last_video > STALL_MS) {
      LOG("main: no video for %d ms; reopening capture", STALL_MS);
      result = -1;
      break;
    }
    if (audio) {
      uint64_t apts;
      int ar = audio_capture_read(audio, pcm, &apts);
      if (ar > 0) {
        activity = 1;
        status_count_audio();
        bc_publish(packet_new(PKT_AUDIO, 0, apts, pcm, sizeof(pcm), NULL, 0));
      } else if (ar < 0) {
        LOG("main: audio read failed 0x%08x; continuing without audio", (unsigned)ar);
        audio_capture_close(audio);
        audio = NULL;
        status_set_capture(cs->width, cs->height, cs->fps, cs->kbps, 0);
      }
    }
    if (t - last_report >= 10000) {
      LOG("main: %llu frames, %.1f fps, %.2f Mbit/s, %d clients",
          (unsigned long long)frames, frames * 1000.0 / (double)(t - last_report),
          bytes * 8.0 / 1000.0 / (double)(t - last_report), bc_client_count());
      frames = bytes = 0;
      last_report = t;
    }
    if (!activity) usleep(1000);
  }
  if (audio) audio_capture_close(audio);
  avcap_close();
  status_set_capture(0, 0, 0, 0, 0);
  return result;
}

static int run_capture(unsigned generation) {
  uint8_t *vbuf = malloc(VIDBUF_SZ);
  if (!vbuf) return 1;
  uint32_t fw = platform_fw_version();
  int captured_before = 0, failures = 0, rotated = 0;
  int notified_error = 0;
  while (!should_stop()) {
    if (bc_client_count() == 0) {
      status_set_state("aguardando o app conectar");
      wait_ms(200);
      continue;
    }
    capture_settings cs;
    unsigned revision = settings_get(&cs);
    status_set_state("abrindo captura %dx%d", cs.width, cs.height);
    int r = avcap_init();
    if (!r) {
      avcap_config ac = {cs.width, cs.height, cs.fps, cs.kbps};
      r = avcap_open(&ac);
    }
    if (r < 0) {
      failures++;
      status_set_error(r);
      status_set_state("falha ao abrir captura (0x%08x)", (unsigned)r);
      LOG("main: capture open failed 0x%08x (%d in a row)", (unsigned)r, failures);
      bc_status("Falha ao abrir a captura (0x%08x). Tentando novamente...", (unsigned)r);
      if (g_supervised && captured_before && failures >= OPEN_FAILURES_BEFORE_RESTART) {
        LOG("main: asking the supervisor for a fresh process");
        bc_status("Reiniciando o servico de captura...");
        control_request_restart(&cs);
        break;
      }
      /* A request rejected as invalid before anything ever worked: try the
       * next record layout once (logged, so the right one can be pinned in
       * config.ini). */
      if (!captured_before && r == AVCAP_INVALID && rotated < 2) {
        req_variant next = alternate_variant(g_cfg.variant, fw);
        LOG("main: trying OpenVideo record variant '%s'", fw_variant_name(next));
        g_cfg.variant = next;
        avcap_options o = {g_cfg.variant, g_cfg.resource_1080, g_cfg.resource_4k};
        avcap_set_options(&o);
        rotated++;
      }
      if (failures >= 3 && !notified_error) {
        NOTIFY("PS5 Screen Share: nao foi possivel abrir a captura (0x%08x). Veja /log.",
               (unsigned)r);
        notified_error = 1;
      }
      wait_ms(failures < 3 ? 2000 : 5000);
      continue;
    }
    failures = 0;
    notified_error = 0;
    captured_before = 1;
    status_set_error(0);
    status_set_platform(fw, avcap_profile_desc(), generation);
    int result = stream_session(&cs, revision, vbuf, generation);
    if (result == 1) {
      LOG("main: settings changed; reopening");
      continue;
    }
    if (result == 2) {
      LOG("main: no viewers; capture closed");
      continue;
    }
    if (result < 0) {
      status_set_error(result);
      bc_status("Captura interrompida (0x%08x), reabrindo...", (unsigned)result);
      if (result == AVCAP_SESSION_LOST)
        LOG("main: video-out mode changed (game started/closed?)");
      wait_ms(1500);
    }
  }
  free(vbuf);
  return 0;
}

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  signal(SIGTERM, on_signal);
  signal(SIGINT, on_signal);
  setvbuf(stdout, NULL, _IONBF, 0);
  log_init("ps5ss", "log.txt");
  LOG("main: PS5 Screen Share %s (pid %d)", PS5SS_VERSION, (int)getpid());

  config_defaults(&g_cfg);
  config_load_file(&g_cfg);
  for (int i = 1; i < argc; i++)
    if (argv[i] && config_apply(&g_cfg, argv[i])) LOG("main: ignoring argument '%s'", argv[i]);
  settings_init(&g_cfg.settings);

  /* The pairing code only matters with a relay; on the home network nothing
   * of it runs. */
  uint8_t secret[PAIR_SECRET_LEN] = {0};
  if (g_cfg.relay_set) {
    char pair_text[PAIR_TEXT_LEN], pair_id_text[PAIR_ID_LEN + 1];
    int pair_created = 0;
    if (pairing_load(PS5SS_DATA_DIR "/pairing.txt", secret, &pair_created)) {
      LOG("pairing: cannot read or create " PS5SS_DATA_DIR "/pairing.txt");
    }
    if (pair_created) LOG("pairing: new pairing code created");
    pair_format(secret, pair_text);
    pair_id(secret, pair_id_text);
    server_set_pairing(pair_text);
    status_set_relay(g_cfg.relay_host, g_cfg.relay_port, pair_id_text);
  }

  pad_init(g_cfg.pad); /* touches nothing on the console until a viewer sends input */
  platform_notify_enable(g_cfg.notify);

  unsigned generation = 0;
  capture_settings sup;
  int have_sup = 0;
  g_supervised = !control_connect(g_cfg.port, &generation, &sup, &have_sup);
  if (g_supervised) {
    LOG("main: supervised, generation %u", generation);
    if (have_sup) settings_set(&sup);
  }

  uint32_t fw = platform_fw_version();
  avcap_options o = {g_cfg.variant, g_cfg.resource_1080, g_cfg.resource_4k};
  avcap_set_options(&o);
  fw_match match;
  const fw_profile *prof = fw_find_profile(fw, &match);
  char profile[64];
  snprintf(profile, sizeof(profile), "perfil %x.%02x (%s)", prof ? (prof->fw >> 24) & 0xff : 0,
           prof ? (prof->fw >> 16) & 0xff : 0,
           match == FW_MATCH_EXACT ? "exato" : match == FW_MATCH_FAMILY ? "familia" : "estimado");
  status_set_platform(fw, profile, generation);
  LOG("main: firmware 0x%08x, %s", fw, profile);

  bc_init();
  int lfd = server_listen(g_cfg.port);
  for (int attempt = 0; lfd == -EADDRINUSE && attempt < 20; attempt++) {
    if (!attempt) {
      LOG("main: port %d busy; asking the running copy to quit", g_cfg.port);
      control_ask_existing_to_quit(g_cfg.port);
    }
    usleep(500000);
    lfd = server_listen(g_cfg.port);
  }
  if (lfd < 0) {
    LOG("main: cannot listen on %d: %s", g_cfg.port, strerror(-lfd));
    platform_notify("PS5 Screen Share: porta %d em uso", g_cfg.port);
    return 1;
  }
  server_start(lfd, g_cfg.port);
  discovery_start(g_cfg.port);
  if (g_cfg.relay_set) {
    if (relay_start(g_cfg.relay_host, g_cfg.relay_port, secret, server_serve_relay)) {
      LOG("relay: cannot start for %s:%d", g_cfg.relay_host, g_cfg.relay_port);
    } else {
      LOG("relay: will connect to %s:%d", g_cfg.relay_host, g_cfg.relay_port);
    }
  }
  memset(secret, 0, sizeof(secret));

  char ip[64] = "?";
  platform_local_ip(ip, sizeof(ip));
  LOG("main: listening on %s:%d", ip, g_cfg.port);
  if (generation <= 1) NOTIFY("PS5 Screen Share pronto em %s:%d", ip, g_cfg.port);

  run_capture(generation);
  pad_shutdown();

  avcap_terminate();
  LOG("main: exiting");
  return 0;
}
