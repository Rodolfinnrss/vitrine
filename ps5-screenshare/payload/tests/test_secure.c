/* Differential tests for the console crypto against Node's crypto module
 * (vectors from relay/test/gen-vectors.js). Copyright (C) 2026 PS5 Screen Share contributors. GPL-3.0-or-later. */
#include "secure.h"
#include "secure_vectors.h"

#include <stdio.h>
#include <string.h>

static int failures;
#define CHECK(c, ...) do { if (!(c)) { failures++; printf("FAIL: " __VA_ARGS__); printf("\n"); } } while (0)

static void hex_to_bytes(const char *hex, uint8_t *out, size_t n) {
  for (size_t i = 0; i < n; i++) {
    unsigned v;
    sscanf(hex + 2 * i, "%2x", &v);
    out[i] = (uint8_t)v;
  }
}

int main(void) {
  /* SHA-256 on its own. */
  for (size_t i = 0; i < VEC_SHA_COUNT; i++) {
    uint8_t d[32];
    sha256(VEC_SHA[i].data, VEC_SHA[i].len, d);
    CHECK(!memcmp(d, VEC_SHA[i].digest, 32), "sha256 vector %zu (len %zu)", i, VEC_SHA[i].len);
  }

  /* Pairing: id, key, and the text form round trip. */
  for (size_t i = 0; i < VEC_PAIRING_COUNT; i++) {
    uint8_t secret[16], key[32];
    char id[17], text[40];
    hex_to_bytes(VEC_PAIRING[i].secret, secret, 16);
    pair_id(secret, id);
    CHECK(!strcmp(id, VEC_PAIRING[i].id), "pair_id %zu: %s", i, id);
    pair_key(secret, key);
    CHECK(!memcmp(key, VEC_PAIRING[i].key, 32), "pair_key %zu", i);
    pair_format(secret, text);
    uint8_t back[16];
    CHECK(pair_parse(text, back) == 0 && !memcmp(back, secret, 16), "format/parse round trip %zu (%s)", i, text);
    CHECK(pair_parse("zz", back) != 0, "pair_parse rejects non-hex");
    CHECK(pair_parse(VEC_PAIRING[i].secret + 2, back) != 0, "pair_parse rejects short input");
    char upper[64];
    for (size_t k = 0; k < 32; k++) upper[k] = (char)((VEC_PAIRING[i].secret[k] >= 'a') ? VEC_PAIRING[i].secret[k] - 32 : VEC_PAIRING[i].secret[k]);
    upper[32] = 0;
    CHECK(pair_parse(upper, back) == 0 && !memcmp(back, secret, 16), "upper case accepted");
    char with_newline[64];
    snprintf(with_newline, sizeof(with_newline), "%s\n", text);
    CHECK(pair_parse(with_newline, back) == 0 && !memcmp(back, secret, 16), "trailing newline accepted (%s)", text);
    snprintf(with_newline, sizeof(with_newline), "  %s\r\n", text);
    CHECK(pair_parse(with_newline, back) == 0 && !memcmp(back, secret, 16), "surrounding whitespace accepted");
  }

  /* Session keys. */
  for (size_t i = 0; i < VEC_SESSION_COUNT; i++) {
    uint8_t out[32];
    pair_session_key(VEC_SESSION[i].key, VEC_SESSION[i].salt, out);
    CHECK(!memcmp(out, VEC_SESSION[i].session, 32), "session key %zu", i);
  }

  /* Frames: seal must match, open must recover the plaintext, and a flipped bit must fail. */
  for (size_t i = 0; i < VEC_FRAME_COUNT; i++) {
    const vec_frame *v = &VEC_FRAME[i];
    uint8_t nonce[12], out[SECURE_MAX_PLAIN > 0 ? 8192 : 1], body[8192 + 16];
    frame_nonce(v->dir, v->seq, nonce);
    aead_seal(v->key, nonce, v->plain, v->plain_len, body);
    CHECK(!memcmp(body, v->body, v->body_len), "seal frame %zu (len %zu)", i, v->plain_len);
    CHECK(aead_open(v->key, nonce, v->body, v->body_len, out) == 0, "open frame %zu", i);
    CHECK(!memcmp(out, v->plain, v->plain_len), "plaintext frame %zu", i);
    if (v->body_len > 0) {
      uint8_t bad[8192 + 16];
      memcpy(bad, v->body, v->body_len);
      bad[v->body_len / 2] ^= 0x01;
      CHECK(aead_open(v->key, nonce, bad, v->body_len, out) != 0, "tampered frame %zu accepted", i);
      uint8_t other[12];
      frame_nonce(v->dir, v->seq + 1, other);
      CHECK(aead_open(v->key, other, v->body, v->body_len, out) != 0, "wrong sequence accepted %zu", i);
    }
  }

  printf(failures ? "%d failures\n" : "secure: all checks passed (%d frames, %d sha)\n",
         failures ? failures : (int)VEC_FRAME_COUNT, (int)VEC_SHA_COUNT);
  return failures ? 1 : 0;
}
