/* Host test for firmware profile lookup and OpenVideo request building.
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * reference_pws() is the record from ps5-web-stream src/avcap.c
 * (video_params), kept here verbatim to pin byte-for-byte equality. */
#include "fwprofiles.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures;
#define CHECK(c, ...) do { if (!(c)) { failures++; printf("FAIL: " __VA_ARGS__); printf("\n"); } } while (0)

static void set32(uint8_t *p, size_t off, uint32_t value) { memcpy(p + off, &value, sizeof(value)); }

static void reference_pws(uint8_t p[0x2e0], int width, int height, int fps, int bitrate,
                          int mode, unsigned resolution, int resource) {
  (void)width;
  static const unsigned sizes[][2] = {
    {0,0x2e0},{8,0x28},{0x30,0x58},{0x38,0x18},{0x50,0x10},
    {0x60,0x18},{0x88,0x30},{0xb8,0xe0},{0xc0,0x20},{0xe0,0x20},
    {0x100,0x20},{0x120,0x18},{0x188,0x10},{0x198,0x50},
    {0x1e8,0xf8},{0x1f0,0x28},{0x218,0x88},{0x2a8,0x10},{0x2b8,0x10}
  };
  memset(p, 0, 0x2e0);
  for (size_t i=0; i<sizeof(sizes)/sizeof(sizes[0]); ++i) set32(p, sizes[i][0], sizes[i][1]);
  set32(p, 0x14, 2); set32(p, 0x18, resolution); set32(p, 0x1c, fps == 60);
  set32(p, 0x24, 0); set32(p, 0x28, (uint32_t)resource);
  set32(p, 0x40, 1); set32(p, 0x44, 245760u/(unsigned)fps/60u);
  set32(p, 0x48, 1); set32(p, 0x4c, 1400*8);
  set32(p, 0x58, 1); set32(p, 0x5c, height >= 2160 ? 4 : 9); set32(p, 0x68, 1);
  uint32_t bps = (uint32_t)bitrate * 1000u;
  set32(p, 0xc8, (uint32_t)((float)bps/1.12f)); set32(p, 0xcc, bps);
  uint32_t frame_bits = (uint32_t)((uint64_t)bps*1001u/((unsigned)fps*1000u));
  set32(p, 0xd0, frame_bits); set32(p, 0xd4, 35); set32(p, 0xd8, 0x33);
  set32(p, 0x108, 1); set32(p, 0x10c, frame_bits/8); set32(p, 0x128, 1); set32(p, 0x12c, 25);
  memset(p+0x220, 0xff, 0x80);
  set32(p, 0x2a0, (uint32_t)mode);
  set32(p, 0x2a4, (mode&1) ? 5 : (mode&2) ? 7 : 2);
  set32(p, 0x2b0, 1); p[0x2b4] = 1; p[0x2b5] = 1;
  p[0x2c0] = 1; set32(p, 0x2c4, 110);
}

static uint32_t get32(const uint8_t *p, size_t off) { uint32_t v; memcpy(&v, p + off, 4); return v; }
static uint64_t get64(const uint8_t *p, size_t off) { uint64_t v; memcpy(&v, p + off, 8); return v; }

int main(void) {
  fw_match m;
  const fw_profile *p = fw_find_profile(0x12000043u, &m);
  CHECK(p && p->fw == 0x12000043u && m == FW_MATCH_EXACT, "12.00 exact");
  p = fw_find_profile(0x12000000u, &m);
  CHECK(p && p->fw == 0x12000043u && m == FW_MATCH_FAMILY, "12.00 other build -> 12.00 family");
  p = fw_find_profile(0x07610001u, &m);
  CHECK(p && p->fw == 0x06020004u && m == FW_MATCH_FAMILY, "7.61 -> 6.02 family");
  p = fw_find_profile(0x10200000u, &m);
  CHECK(p && p->fw == 0x10010000u && m == FW_MATCH_FAMILY, "10.20 -> 10.01 family");
  p = fw_find_profile(0x14000000u, &m);
  CHECK(p && p->fw == 0x13600007u && m == FW_MATCH_GUESS, "14.00 -> guess 13.60");
  p = fw_find_profile(0x04030000u, &m);
  CHECK(p && p->fw == 0x04000042u && m == FW_MATCH_GUESS, "4.03 -> guess 4.00");
  p = fw_find_profile(0x01000000u, &m);
  CHECK(p && p->fw == 0x03200004u && m == FW_MATCH_GUESS, "1.00 -> oldest profile");

  CHECK(fw_resolution_code(0x04510001u, 1440) < 0, "no 1440p before 6.xx");
  CHECK(fw_resolution_code(0x04510001u, 2160) == 5, "legacy 4K code");
  CHECK(fw_resolution_code(0x09600004u, 2160) == 6, "modern 4K code");
  CHECK(fw_resolution_code(0x09600004u, 1080) == 4, "1080p code");

  /* Variant choice */
  p = fw_find_profile(0x12000043u, &m);
  CHECK(fw_auto_variant(0x12000043u, p, m) == REQ_PWS, "0x2e0 family uses pws record");
  p = fw_find_profile(0x09400008u, &m);
  CHECK(fw_auto_variant(0x09400008u, p, m) == REQ_SYNTHETIC, "9.40 synthetic (PBS #12)");
  p = fw_find_profile(0x09600004u, &m);
  CHECK(fw_auto_variant(0x09600004u, p, m) == REQ_NATIVE, "9.60 native");
  p = fw_find_profile(0x07610001u, &m);
  CHECK(fw_auto_variant(0x07610001u, p, m) == REQ_SYNTHETIC, "7.61 family synthetic");

  /* Byte-for-byte equality with ps5-web-stream for every mode it ships. */
  static const struct { int w, h, fps, kbps, code, res; } modes[] = {
    {1280, 720, 60, 5000, 3, 0xb4}, {1920, 1080, 60, 8000, 4, 0xb4},
    {2560, 1440, 60, 16000, 5, 0xb6}, {3840, 2160, 60, 32000, 6, 0xb6},
    {1920, 1080, 30, 6000, 4, 0xb4},
  };
  p = fw_find_profile(0x12000043u, &m);
  for (size_t i = 0; i < sizeof(modes) / sizeof(modes[0]); i++) {
    uint8_t ours[0x400], ref[0x2e0];
    req_params rp = {modes[i].w, modes[i].h, modes[i].fps, modes[i].kbps, modes[i].code,
                     modes[i].res, 0x13c};
    int n = fw_build_request(ours, sizeof(ours), p, REQ_PWS, &rp);
    reference_pws(ref, modes[i].w, modes[i].h, modes[i].fps, modes[i].kbps, 0x13c,
                  (unsigned)modes[i].code, modes[i].res);
    CHECK(n == 0x2e0 && !memcmp(ours, ref, 0x2e0), "pws record identical for %dx%d@%d",
          modes[i].w, modes[i].h, modes[i].fps);
  }

  /* Native/synthetic records for every measured profile stay in bounds and
   * carry the measured descriptor sizes. */
  for (unsigned i = 0; i < fw_profile_count; i++) {
    const fw_profile *f = &fw_profiles[i];
    for (int v = REQ_NATIVE; v <= REQ_SYNTHETIC; v++) {
      uint8_t buf[0x400];
      memset(buf, 0xcc, sizeof(buf));
      req_params rp = {1920, 1080, 60, 8000, fw_resolution_code(f->fw, 1080), 0xb4, 0x13c};
      int n = fw_build_request(buf, sizeof(buf), f, (req_variant)v, &rp);
      CHECK(n == f->request_size, "fw %08x variant %d size", f->fw, v);
      CHECK(buf[f->request_size] == 0xcc, "fw %08x variant %d writes past the record", f->fw, v);
      CHECK(get64(buf, 0) == f->request_size && get64(buf, 8) == 0x28, "fw %08x header", f->fw);
      CHECK(get64(buf, f->rate.off) == f->rate.size, "fw %08x rate descriptor", f->fw);
      CHECK(get64(buf, f->image.off) == f->image.size, "fw %08x image descriptor", f->fw);
      CHECK(get32(buf, f->width_off) == 1920 && get32(buf, f->height_off) == 1080,
            "fw %08x geometry", f->fw);
      CHECK(get64(buf, f->paste_off) == 0x88 && buf[f->paste_off + 8] == 0xff &&
            buf[f->paste_off + 0x87] == 0xff, "fw %08x paste", f->fw);
      CHECK(get32(buf, f->vmode_off) == 0x13c && get32(buf, f->mask_off) == 2,
            "fw %08x mode/mask", f->fw);
      CHECK(get32(buf, 0x28) == 0xb4 && get32(buf, 0x18) == 4, "fw %08x resource/res", f->fw);
      CHECK(get32(buf, f->kind_off) == 0, "fw %08x kind stays 0", f->fw);
    }
    uint8_t buf[0x400];
    req_params rp = {1920, 1080, 60, 8000, 4, 0xb4, 0};
    CHECK((fw_build_request(buf, sizeof(buf), f, REQ_PWS, &rp) > 0) == (f->request_size == 0x2e0),
          "pws only for 0x2e0 (fw %08x)", f->fw);
  }
  if (failures) { printf("%d failures\n", failures); return 1; }
  printf("fwprofiles: all checks passed (%u profiles)\n", fw_profile_count);
  return 0;
}
