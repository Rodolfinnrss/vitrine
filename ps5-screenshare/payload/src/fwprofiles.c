/* PS5 Screen Share - firmware profile lookup and OpenVideo request builder.
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Profile selection rules (exact build, audited family ranges) follow
 * PBS-Payload's registry. The 0x2e0 record (FW 11.20 - 13.20 geometry) is
 * filled exactly like ps5-web-stream's console-validated implementation.
 */
#include "fwprofiles.h"

#include <string.h>

static void put32(uint8_t *p, size_t off, uint32_t v) { memcpy(p + off, &v, 4); }
static void put64(uint8_t *p, size_t off, uint64_t v) { memcpy(p + off, &v, 8); }

int fw_legacy_resolutions(uint32_t fw) {
  /* SceAvCapture's resolution table gained 2560 (1440p) in 6.xx. */
  return fw < 0x06000000u;
}

int fw_resolution_code(uint32_t fw, int height) {
  switch (height) {
    case 720: return 3;
    case 1080: return 4;
    case 1440: return fw_legacy_resolutions(fw) ? -1 : 5;
    case 2160: return fw_legacy_resolutions(fw) ? 5 : 6;
    default: return -1;
  }
}

const char *fw_variant_name(req_variant v) {
  switch (v) {
    case REQ_PWS: return "pws";
    case REQ_NATIVE: return "native";
    case REQ_SYNTHETIC: return "synthetic";
    default: return "auto";
  }
}

static int in_audited_family(uint32_t version) {
  static const uint32_t releases[] = {
    0x06020000u, 0x06500000u, 0x07000000u, 0x07010000u, 0x07200000u,
    0x07400000u, 0x07600000u, 0x07610000u, 0x08000000u, 0x08200000u,
    0x08400000u, 0x09200000u, 0x09400000u, 0x10010000u, 0x10200000u,
    0x10400000u, 0x10600000u, 0x11400000u, 0x11600000u, 0x12000000u,
    0x12020000u, 0x12200000u, 0x12400000u, 0x12600000u, 0x12700000u,
    0x13400000u, 0x13420000u, 0x13600000u,
  };
  for (size_t i = 0; i < sizeof(releases) / sizeof(releases[0]); i++)
    if (releases[i] == version) return 1;
  return 0;
}

static const fw_profile *by_id(uint32_t fw) {
  for (unsigned i = 0; i < fw_profile_count; i++)
    if (fw_profiles[i].fw == fw) return &fw_profiles[i];
  return NULL;
}

const fw_profile *fw_find_profile(uint32_t fw, fw_match *match) {
  const fw_profile *p = by_id(fw);
  if (p) { if (match) *match = FW_MATCH_EXACT; return p; }
  uint32_t version = fw & 0xffff0000u;
  /* Another build of a measured release. */
  for (unsigned i = 0; i < fw_profile_count; i++) {
    if ((fw_profiles[i].fw & 0xffff0000u) == version) {
      if (match) *match = FW_MATCH_FAMILY;
      return &fw_profiles[i];
    }
  }
  if (in_audited_family(version)) {
    uint32_t anchor = 0;
    if (version >= 0x06020000u && version <= 0x08400000u) anchor = 0x06020004u;
    else if (version >= 0x09200000u && version <= 0x09400000u) anchor = 0x09200005u;
    else if (version >= 0x10010000u && version <= 0x10600000u) anchor = 0x10010000u;
    else if (version >= 0x11400000u && version <= 0x12700000u) anchor = 0x11600005u;
    else if (version >= 0x13400000u && version <= 0x13600000u) anchor = 0x13600007u;
    if (anchor && (p = by_id(anchor))) {
      if (match) *match = FW_MATCH_FAMILY;
      return p;
    }
  }
  /* Unknown firmware: the nearest older profile is the best guess. */
  const fw_profile *best = NULL;
  for (unsigned i = 0; i < fw_profile_count; i++)
    if (fw_profiles[i].fw <= fw && (!best || fw_profiles[i].fw > best->fw))
      best = &fw_profiles[i];
  if (!best && fw_profile_count) best = &fw_profiles[0];
  if (match) *match = FW_MATCH_GUESS;
  return best;
}

req_variant fw_auto_variant(uint32_t fw, const fw_profile *p, fw_match match) {
  if (!p) return REQ_SYNTHETIC;
  if (p->request_size == 0x2e0) return REQ_PWS;
  /* PBS-Payload issue #12: on 9.40 and 5.50 the constructor-built request is
   * rejected with 0x81950001 while the synthetic record opens. */
  uint32_t version = fw & 0xffff0000u;
  if (version == 0x09400000u || version == 0x05500000u) return REQ_SYNTHETIC;
  if (match != FW_MATCH_GUESS && (p->fw & 0xffff0000u) == version) return REQ_NATIVE;
  return REQ_SYNTHETIC;
}

/* ps5-web-stream's full versioned 0x2e0 record (RemoteplayDaemon 0x57770). */
static void build_pws(uint8_t p[0x2e0], const req_params *rp) {
  static const unsigned sizes[][2] = {
    {0, 0x2e0}, {8, 0x28}, {0x30, 0x58}, {0x38, 0x18}, {0x50, 0x10},
    {0x60, 0x18}, {0x88, 0x30}, {0xb8, 0xe0}, {0xc0, 0x20}, {0xe0, 0x20},
    {0x100, 0x20}, {0x120, 0x18}, {0x188, 0x10}, {0x198, 0x50},
    {0x1e8, 0xf8}, {0x1f0, 0x28}, {0x218, 0x88}, {0x2a8, 0x10}, {0x2b8, 0x10},
  };
  memset(p, 0, 0x2e0);
  for (size_t i = 0; i < sizeof(sizes) / sizeof(sizes[0]); ++i)
    put32(p, sizes[i][0], sizes[i][1]);
  unsigned fps = (unsigned)rp->fps;
  put32(p, 0x14, 2);                       /* Remote Play source */
  put32(p, 0x18, (uint32_t)rp->resolution_code);
  put32(p, 0x1c, rp->fps == 60);           /* cadence selector */
  put32(p, 0x24, 0);                       /* AVC */
  put32(p, 0x28, (uint32_t)rp->resource);  /* active ResourceArbitrator ID */
  put32(p, 0x40, 1); put32(p, 0x44, 245760u / fps / 60u);
  put32(p, 0x48, 1); put32(p, 0x4c, 1400 * 8);
  put32(p, 0x58, 1); put32(p, 0x5c, rp->height >= 2160 ? 4 : 9); put32(p, 0x68, 1);
  uint32_t bps = (uint32_t)rp->kbps * 1000u;
  put32(p, 0xc8, (uint32_t)((float)bps / 1.12f)); put32(p, 0xcc, bps);
  uint32_t frame_bits = (uint32_t)((uint64_t)bps * 1001u / (fps * 1000u));
  put32(p, 0xd0, frame_bits); put32(p, 0xd4, 35); put32(p, 0xd8, 51);
  put32(p, 0x108, 1); put32(p, 0x10c, frame_bits / 8);
  put32(p, 0x128, 1); put32(p, 0x12c, 25);
  memset(p + 0x220, 0xff, 0x80);
  put32(p, 0x2a0, (uint32_t)rp->video_mode);
  put32(p, 0x2a4, (rp->video_mode & 1) ? 5 : (rp->video_mode & 2) ? 7 : 2);
  put32(p, 0x2b0, 1); p[0x2b4] = 1; p[0x2b5] = 1;
  p[0x2c0] = 1; put32(p, 0x2c4, 110);
}

static int fits(const fw_profile *f, size_t off, size_t len) {
  return off + len <= f->request_size;
}

int fw_build_request(uint8_t *out, size_t cap, const fw_profile *f,
                     req_variant v, const req_params *rp) {
  if (!out || !f || !rp || cap < f->request_size || rp->fps <= 0 ||
      rp->kbps <= 0 || rp->resolution_code < 0) return -1;
  if (v == REQ_AUTO) v = REQ_SYNTHETIC;
  if (v == REQ_PWS) {
    if (f->request_size != 0x2e0) return -1;
    build_pws(out, rp);
    return 0x2e0;
  }
  if (!fits(f, f->rate.off, 0x24) || !fits(f, f->image.off, 0x10) ||
      !fits(f, f->width_off, 4) || !fits(f, f->height_off, 4) ||
      !fits(f, f->paste_off, 0x88) || !fits(f, f->vmode_off, 4) ||
      !fits(f, f->mask_off, f->mask_span)) return -1;
  memset(out, 0, f->request_size);
  if (v == REQ_NATIVE) {
    for (unsigned i = 0; i < f->ninit; i++) {
      const fw_init *in = &f->inits[i];
      if (!in->len || in->len > sizeof(in->bytes) || !fits(f, in->off, in->len))
        return -1;
      memcpy(out + in->off, in->bytes, in->len);
    }
    /* The constructor's encoder-mode selector refers to descriptors native
     * Remote Play fills later; keep the proven kind=0 path. */
    size_t mode_begin = (size_t)f->rate.off + f->rate.size;
    if (mode_begin < f->image.off) memset(out + mode_begin, 0, f->image.off - mode_begin);
  }
  uint32_t bps = (uint32_t)rp->kbps * 1000u;
  uint32_t frame_bits = (uint32_t)((uint64_t)bps * 1001u / ((unsigned)rp->fps * 1000u));
  put64(out, 0, f->request_size);
  put64(out, 8, 0x28);
  put32(out, 0x14, 2);
  put32(out, 0x18, (uint32_t)rp->resolution_code);
  put32(out, 0x1c, rp->fps == 60);
  put32(out, 0x28, (uint32_t)rp->resource);
  put64(out, f->rate.off, f->rate.size);
  put64(out, f->rate.off + 8, f->rate.desc);
  put32(out, f->rate.off + 0x10, (uint32_t)((float)bps / 1.12f));
  put32(out, f->rate.off + 0x14, bps);
  put32(out, f->rate.off + 0x18, frame_bits);
  put32(out, f->rate.off + 0x1c, 35);
  put32(out, f->rate.off + 0x20, 51);
  put64(out, f->image.off, f->image.size);
  put64(out, f->image.off + 8, f->image.desc);
  put32(out, f->width_off, (uint32_t)rp->width);
  put32(out, f->height_off, (uint32_t)rp->height);
  put64(out, f->paste_off, 0x88);
  memset(out + f->paste_off + 8, 0xff, 0x80);
  put32(out, f->vmode_off, (uint32_t)rp->video_mode);
  put32(out, f->mask_off, (rp->video_mode & 1) ? 5 : (rp->video_mode & 2) ? 7 : 2);
  put64(out, f->mask_off + 4, 0x10);
  put32(out, f->mask_off + 0xc, 1);
  out[f->mask_off + 0x10] = 1;
  if (f->mask_span >= 0x24) {
    put64(out, f->mask_off + 0x14, 0x10);
    out[f->mask_off + 0x1c] = 1;
    put32(out, f->mask_off + 0x20, 110);
  }
  return f->request_size;
}
