/* PS5 Screen Share - end-to-end encryption for the relay (pairing, keys, frames).
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Spec: relay/PROTOCOL.md. ChaCha20-Poly1305 (RFC 8439) and SHA-256 (FIPS 180-4),
 * written here so the console build has no crypto dependency. Tested against
 * Node's crypto module in payload/tests/test_secure.c.
 */
#ifndef PS5SS_SECURE_H
#define PS5SS_SECURE_H

#include <stddef.h>
#include <stdint.h>

#define PAIR_SECRET_LEN 16
#define PAIR_ID_LEN 16          /* hex characters */
#define PAIR_TEXT_LEN 40        /* "xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx" + NUL */
#define SECURE_TAG_LEN 16
#define SECURE_MAX_PLAIN (8u * 1024u * 1024u)

void sha256(const uint8_t *data, size_t len, uint8_t out[32]);

/* RFC 8439 AEAD. out receives len + 16 bytes. */
void aead_seal(const uint8_t key[32], const uint8_t nonce[12], const uint8_t *in, size_t len,
               uint8_t *out);
/* Returns 0 and writes len - 16 bytes when the tag verifies; -1 otherwise. */
int aead_open(const uint8_t key[32], const uint8_t nonce[12], const uint8_t *in, size_t len,
              uint8_t *out);

/* Pairing secret: 16 random bytes shown as 32 hex characters in groups of 4. */
void pair_format(const uint8_t secret[PAIR_SECRET_LEN], char out[PAIR_TEXT_LEN]);
/* Accepts hex with or without dashes and spaces, any case. Returns 0 on success. */
int pair_parse(const char *text, uint8_t secret[PAIR_SECRET_LEN]);
/* 16 lowercase hex characters the relay uses to route to this console. */
void pair_id(const uint8_t secret[PAIR_SECRET_LEN], char out[PAIR_ID_LEN + 1]);
void pair_key(const uint8_t secret[PAIR_SECRET_LEN], uint8_t key[32]);
void pair_session_key(const uint8_t key[32], const uint8_t salt[16], uint8_t out[32]);

/* Frame nonce: direction byte, three zero bytes, 64-bit big-endian sequence number. */
void frame_nonce(uint8_t dir, uint64_t seq, uint8_t nonce[12]);

#endif
