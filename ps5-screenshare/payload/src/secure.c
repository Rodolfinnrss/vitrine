/* PS5 Screen Share - end-to-end encryption (see secure.h).
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "secure.h"

#include <string.h>

/* ----------------------------------------------------------------- SHA-256 */

static const uint32_t K256[64] = {
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

static uint32_t ror32(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

static void sha256_block(uint32_t h[8], const uint8_t *p) {
  uint32_t w[64];
  for (int i = 0; i < 16; i++)
    w[i] = ((uint32_t)p[4 * i] << 24) | ((uint32_t)p[4 * i + 1] << 16) |
           ((uint32_t)p[4 * i + 2] << 8) | p[4 * i + 3];
  for (int i = 16; i < 64; i++) {
    uint32_t s0 = ror32(w[i - 15], 7) ^ ror32(w[i - 15], 18) ^ (w[i - 15] >> 3);
    uint32_t s1 = ror32(w[i - 2], 17) ^ ror32(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
  for (int i = 0; i < 64; i++) {
    uint32_t S1 = ror32(e, 6) ^ ror32(e, 11) ^ ror32(e, 25);
    uint32_t ch = (e & f) ^ (~e & g);
    uint32_t t1 = hh + S1 + ch + K256[i] + w[i];
    uint32_t S0 = ror32(a, 2) ^ ror32(a, 13) ^ ror32(a, 22);
    uint32_t mj = (a & b) ^ (a & c) ^ (b & c);
    uint32_t t2 = S0 + mj;
    hh = g; g = f; f = e; e = d + t1;
    d = c; c = b; b = a; a = t1 + t2;
  }
  h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
}

void sha256(const uint8_t *data, size_t len, uint8_t out[32]) {
  uint32_t h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                   0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  size_t full = len & ~(size_t)63;
  for (size_t i = 0; i < full; i += 64) sha256_block(h, data + i);
  uint8_t tail[128] = {0};
  size_t rest = len - full;
  memcpy(tail, data + full, rest);
  tail[rest] = 0x80;
  size_t tail_len = rest + 1 + 8 <= 64 ? 64 : 128;
  uint64_t bits = (uint64_t)len * 8;
  for (int i = 0; i < 8; i++) tail[tail_len - 1 - i] = (uint8_t)(bits >> (8 * i));
  sha256_block(h, tail);
  if (tail_len == 128) sha256_block(h, tail + 64);
  for (int i = 0; i < 8; i++) {
    out[4 * i] = (uint8_t)(h[i] >> 24);
    out[4 * i + 1] = (uint8_t)(h[i] >> 16);
    out[4 * i + 2] = (uint8_t)(h[i] >> 8);
    out[4 * i + 3] = (uint8_t)h[i];
  }
}

/* ---------------------------------------------------------------- ChaCha20 */

static uint32_t rotl32(uint32_t v, int n) { return (v << n) | (v >> (32 - n)); }
static uint32_t le32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static void put_le32(uint8_t *p, uint32_t v) {
  p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}

#define QR(a, b, c, d)                                  \
  do {                                                  \
    a += b; d ^= a; d = rotl32(d, 16);                  \
    c += d; b ^= c; b = rotl32(b, 12);                  \
    a += b; d ^= a; d = rotl32(d, 8);                   \
    c += d; b ^= c; b = rotl32(b, 7);                   \
  } while (0)

static void chacha20_block(const uint32_t in[16], uint32_t out[16]) {
  uint32_t x[16];
  memcpy(x, in, sizeof(x));
  for (int i = 0; i < 10; i++) {
    QR(x[0], x[4], x[8], x[12]);
    QR(x[1], x[5], x[9], x[13]);
    QR(x[2], x[6], x[10], x[14]);
    QR(x[3], x[7], x[11], x[15]);
    QR(x[0], x[5], x[10], x[15]);
    QR(x[1], x[6], x[11], x[12]);
    QR(x[2], x[7], x[8], x[13]);
    QR(x[3], x[4], x[9], x[14]);
  }
  for (int i = 0; i < 16; i++) out[i] = x[i] + in[i];
}

static void chacha20_setup(uint32_t st[16], const uint8_t key[32], const uint8_t nonce[12],
                           uint32_t counter) {
  st[0] = 0x61707865; st[1] = 0x3320646e; st[2] = 0x79622d32; st[3] = 0x6b206574;
  for (int i = 0; i < 8; i++) st[4 + i] = le32(key + 4 * i);
  st[12] = counter;
  for (int i = 0; i < 3; i++) st[13 + i] = le32(nonce + 4 * i);
}

static void chacha20_xor(const uint8_t key[32], const uint8_t nonce[12], uint32_t counter,
                         const uint8_t *in, size_t len, uint8_t *out) {
  uint32_t st[16], ks[16];
  chacha20_setup(st, key, nonce, counter);
  uint8_t block[64];
  for (size_t off = 0; off < len; off += 64) {
    chacha20_block(st, ks);
    for (int i = 0; i < 16; i++) put_le32(block + 4 * i, ks[i]);
    size_t n = len - off < 64 ? len - off : 64;
    for (size_t i = 0; i < n; i++) out[off + i] = in[off + i] ^ block[i];
    st[12]++;
  }
}

/* ----------------------------------------------------------------- Poly1305 */
/* 26-bit limbs (poly1305-donna, 32-bit variant): only 64-bit products, no
 * 128-bit arithmetic, so the console's compiler runtime is not needed. */

typedef struct {
  uint32_t r[5], h[5], pad[4];
  size_t leftover;
  uint8_t buffer[16];
  int final;
} poly1305;

static void poly_init(poly1305 *st, const uint8_t key[32]) {
  st->r[0] = le32(key + 0) & 0x3ffffff;
  st->r[1] = (le32(key + 3) >> 2) & 0x3ffff03;
  st->r[2] = (le32(key + 6) >> 4) & 0x3ffc0ff;
  st->r[3] = (le32(key + 9) >> 6) & 0x3f03fff;
  st->r[4] = (le32(key + 12) >> 8) & 0x00fffff;
  for (int i = 0; i < 5; i++) st->h[i] = 0;
  for (int i = 0; i < 4; i++) st->pad[i] = le32(key + 16 + 4 * i);
  st->leftover = 0;
  st->final = 0;
}

static void poly_blocks(poly1305 *st, const uint8_t *m, size_t bytes) {
  const uint32_t hibit = st->final ? 0 : (1u << 24);
  const uint32_t r0 = st->r[0], r1 = st->r[1], r2 = st->r[2], r3 = st->r[3], r4 = st->r[4];
  const uint32_t s1 = r1 * 5, s2 = r2 * 5, s3 = r3 * 5, s4 = r4 * 5;
  uint32_t h0 = st->h[0], h1 = st->h[1], h2 = st->h[2], h3 = st->h[3], h4 = st->h[4];
  while (bytes >= 16) {
    h0 += le32(m + 0) & 0x3ffffff;
    h1 += (le32(m + 3) >> 2) & 0x3ffffff;
    h2 += (le32(m + 6) >> 4) & 0x3ffffff;
    h3 += (le32(m + 9) >> 6) & 0x3ffffff;
    h4 += (le32(m + 12) >> 8) | hibit;

    uint64_t d0 = (uint64_t)h0 * r0 + (uint64_t)h1 * s4 + (uint64_t)h2 * s3 + (uint64_t)h3 * s2 + (uint64_t)h4 * s1;
    uint64_t d1 = (uint64_t)h0 * r1 + (uint64_t)h1 * r0 + (uint64_t)h2 * s4 + (uint64_t)h3 * s3 + (uint64_t)h4 * s2;
    uint64_t d2 = (uint64_t)h0 * r2 + (uint64_t)h1 * r1 + (uint64_t)h2 * r0 + (uint64_t)h3 * s4 + (uint64_t)h4 * s3;
    uint64_t d3 = (uint64_t)h0 * r3 + (uint64_t)h1 * r2 + (uint64_t)h2 * r1 + (uint64_t)h3 * r0 + (uint64_t)h4 * s4;
    uint64_t d4 = (uint64_t)h0 * r4 + (uint64_t)h1 * r3 + (uint64_t)h2 * r2 + (uint64_t)h3 * r1 + (uint64_t)h4 * r0;

    uint32_t c = (uint32_t)(d0 >> 26); h0 = (uint32_t)d0 & 0x3ffffff;
    d1 += c; c = (uint32_t)(d1 >> 26); h1 = (uint32_t)d1 & 0x3ffffff;
    d2 += c; c = (uint32_t)(d2 >> 26); h2 = (uint32_t)d2 & 0x3ffffff;
    d3 += c; c = (uint32_t)(d3 >> 26); h3 = (uint32_t)d3 & 0x3ffffff;
    d4 += c; c = (uint32_t)(d4 >> 26); h4 = (uint32_t)d4 & 0x3ffffff;
    h0 += c * 5; c = h0 >> 26; h0 &= 0x3ffffff;
    h1 += c;

    m += 16;
    bytes -= 16;
  }
  st->h[0] = h0; st->h[1] = h1; st->h[2] = h2; st->h[3] = h3; st->h[4] = h4;
}

static void poly_update(poly1305 *st, const uint8_t *m, size_t bytes) {
  if (st->leftover) {
    size_t want = 16 - st->leftover;
    if (want > bytes) want = bytes;
    memcpy(st->buffer + st->leftover, m, want);
    bytes -= want;
    m += want;
    st->leftover += want;
    if (st->leftover < 16) return;
    poly_blocks(st, st->buffer, 16);
    st->leftover = 0;
  }
  if (bytes >= 16) {
    size_t full = bytes & ~(size_t)15;
    poly_blocks(st, m, full);
    m += full;
    bytes -= full;
  }
  if (bytes) {
    memcpy(st->buffer, m, bytes);
    st->leftover = bytes;
  }
}

static void poly_finish(poly1305 *st, uint8_t mac[16]) {
  if (st->leftover) {
    size_t i = st->leftover;
    st->buffer[i++] = 1;
    for (; i < 16; i++) st->buffer[i] = 0;
    st->final = 1;
    poly_blocks(st, st->buffer, 16);
  }
  uint32_t h0 = st->h[0], h1 = st->h[1], h2 = st->h[2], h3 = st->h[3], h4 = st->h[4];
  uint32_t c = h1 >> 26; h1 &= 0x3ffffff;
  h2 += c; c = h2 >> 26; h2 &= 0x3ffffff;
  h3 += c; c = h3 >> 26; h3 &= 0x3ffffff;
  h4 += c; c = h4 >> 26; h4 &= 0x3ffffff;
  h0 += c * 5; c = h0 >> 26; h0 &= 0x3ffffff;
  h1 += c;

  /* h - p, to pick the reduced value when it is >= p. */
  uint32_t g0 = h0 + 5; c = g0 >> 26; g0 &= 0x3ffffff;
  uint32_t g1 = h1 + c; c = g1 >> 26; g1 &= 0x3ffffff;
  uint32_t g2 = h2 + c; c = g2 >> 26; g2 &= 0x3ffffff;
  uint32_t g3 = h3 + c; c = g3 >> 26; g3 &= 0x3ffffff;
  uint32_t g4 = h4 + c - (1u << 26);

  uint32_t mask = (g4 >> 31) - 1;
  g0 &= mask; g1 &= mask; g2 &= mask; g3 &= mask; g4 &= mask;
  mask = ~mask;
  h0 = (h0 & mask) | g0;
  h1 = (h1 & mask) | g1;
  h2 = (h2 & mask) | g2;
  h3 = (h3 & mask) | g3;
  h4 = (h4 & mask) | g4;

  h0 = h0 | (h1 << 26);
  h1 = (h1 >> 6) | (h2 << 20);
  h2 = (h2 >> 12) | (h3 << 14);
  h3 = (h3 >> 18) | (h4 << 8);

  uint64_t f = (uint64_t)h0 + st->pad[0]; h0 = (uint32_t)f;
  f = (uint64_t)h1 + st->pad[1] + (f >> 32); h1 = (uint32_t)f;
  f = (uint64_t)h2 + st->pad[2] + (f >> 32); h2 = (uint32_t)f;
  f = (uint64_t)h3 + st->pad[3] + (f >> 32); h3 = (uint32_t)f;

  put_le32(mac + 0, h0); put_le32(mac + 4, h1); put_le32(mac + 8, h2); put_le32(mac + 12, h3);
}

/* ---------------------------------------------------------------- AEAD */

static void aead_tag(const uint8_t key[32], const uint8_t nonce[12], const uint8_t *ct, size_t len,
                     uint8_t tag[16]) {
  uint8_t otk[64] = {0};
  uint32_t st[16], ks[16];
  chacha20_setup(st, key, nonce, 0);
  chacha20_block(st, ks);
  for (int i = 0; i < 16; i++) put_le32(otk + 4 * i, ks[i]);
  poly1305 p;
  poly_init(&p, otk);
  /* No additional data: the MAC input is ciphertext, padded to 16, then the two
   * lengths as 64-bit little-endian numbers (RFC 8439 section 2.8). */
  poly_update(&p, ct, len);
  if (len % 16) {
    uint8_t zero[16] = {0};
    poly_update(&p, zero, 16 - len % 16);
  }
  uint8_t lens[16] = {0};
  for (int i = 0; i < 8; i++) lens[8 + i] = (uint8_t)((uint64_t)len >> (8 * i));
  poly_update(&p, lens, 16);
  poly_finish(&p, tag);
}

void aead_seal(const uint8_t key[32], const uint8_t nonce[12], const uint8_t *in, size_t len,
               uint8_t *out) {
  chacha20_xor(key, nonce, 1, in, len, out);
  aead_tag(key, nonce, out, len, out + len);
}

int aead_open(const uint8_t key[32], const uint8_t nonce[12], const uint8_t *in, size_t len,
              uint8_t *out) {
  if (len < SECURE_TAG_LEN) return -1;
  size_t body = len - SECURE_TAG_LEN;
  uint8_t tag[16];
  aead_tag(key, nonce, in, body, tag);
  /* Constant-time comparison. */
  uint8_t diff = 0;
  for (int i = 0; i < 16; i++) diff |= tag[i] ^ in[body + i];
  if (diff) return -1;
  chacha20_xor(key, nonce, 1, in, body, out);
  return 0;
}

/* ----------------------------------------------------------- pairing */

static const char HEX[] = "0123456789abcdef";

void pair_format(const uint8_t secret[PAIR_SECRET_LEN], char out[PAIR_TEXT_LEN]) {
  size_t o = 0;
  for (int i = 0; i < PAIR_SECRET_LEN; i++) {
    out[o++] = HEX[secret[i] >> 4];
    out[o++] = HEX[secret[i] & 15];
    if (o < PAIR_TEXT_LEN - 1 && o % 5 == 4) out[o++] = '-';
  }
  out[o] = 0;
}

static int hexval(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

int pair_parse(const char *text, uint8_t secret[PAIR_SECRET_LEN]) {
  if (!text) return -1;
  int n = 0, hi = -1;
  for (const char *p = text; *p; p++) {
    if (*p == '-' || *p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') continue;
    int v = hexval(*p);
    if (v < 0) return -1;
    if (hi < 0) {
      hi = v;
    } else {
      if (n >= PAIR_SECRET_LEN) return -1;
      secret[n++] = (uint8_t)(hi << 4 | v);
      hi = -1;
    }
  }
  return n == PAIR_SECRET_LEN && hi < 0 ? 0 : -1;
}

static void sha_tagged(const char *tag, const uint8_t *a, size_t alen, const uint8_t *b, size_t blen,
                       uint8_t out[32]) {
  size_t tl = strlen(tag);
  uint8_t buf[64 + 16 + 32];
  size_t n = 0;
  memcpy(buf, tag, tl); n += tl;
  memcpy(buf + n, a, alen); n += alen;
  if (blen) { memcpy(buf + n, b, blen); n += blen; }
  sha256(buf, n, out);
}

void pair_key(const uint8_t secret[PAIR_SECRET_LEN], uint8_t key[32]) {
  sha_tagged("ps5ss-key-v1", secret, PAIR_SECRET_LEN, NULL, 0, key);
}

void pair_id(const uint8_t secret[PAIR_SECRET_LEN], char out[PAIR_ID_LEN + 1]) {
  uint8_t d[32];
  sha_tagged("ps5ss-id-v1", secret, PAIR_SECRET_LEN, NULL, 0, d);
  for (int i = 0; i < 8; i++) {
    out[2 * i] = HEX[d[i] >> 4];
    out[2 * i + 1] = HEX[d[i] & 15];
  }
  out[PAIR_ID_LEN] = 0;
}

void pair_session_key(const uint8_t key[32], const uint8_t salt[16], uint8_t out[32]) {
  sha_tagged("ps5ss-sess-v1", key, 32, salt, 16, out);
}

void frame_nonce(uint8_t dir, uint64_t seq, uint8_t nonce[12]) {
  nonce[0] = dir;
  nonce[1] = nonce[2] = nonce[3] = 0;
  for (int i = 0; i < 8; i++) nonce[4 + i] = (uint8_t)(seq >> (56 - 8 * i));
}
