/* PS5 Screen Share - sealed sessions through the relay (Electron main process).
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Spec: relay/PROTOCOL.md. Uses Node's built-in ChaCha20-Poly1305 (RFC 8439).
 */
'use strict';

const crypto = require('node:crypto');
// Electron's bundled crypto (BoringSSL) has no 'chacha20-poly1305' cipher name, so
// the AEAD comes from a pure JavaScript implementation (RFC 8439, MIT licensed).
const { ChaCha20Poly1305 } = require('@stablelib/chacha20poly1305');

const DIR_CLIENT = 0x43; // app -> console
const DIR_SERVER = 0x53; // console -> app
const TAG_LEN = 16;
const MAX_PLAIN = 8 * 1024 * 1024;

function sha256(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

/** 32 hex characters; dashes, spaces and case are ignored. Throws if invalid. */
function pairingSecret(text) {
  const raw = String(text || '').replace(/[-\s]/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(raw)) {
    throw new Error('O código de pareamento tem 32 caracteres hexadecimais (ex.: 0011-2233-...)');
  }
  return Buffer.from(raw, 'hex');
}

const pairingId = (secret) => sha256(Buffer.from('ps5ss-id-v1'), secret).subarray(0, 8).toString('hex');
const pairingKey = (secret) => sha256(Buffer.from('ps5ss-key-v1'), secret);
const sessionKey = (key, salt) => sha256(Buffer.from('ps5ss-sess-v1'), key, salt);

function frameNonce(dir, seq) {
  const n = Buffer.alloc(12);
  n[0] = dir;
  n.writeUInt32BE(Math.floor(seq / 0x100000000), 4);
  n.writeUInt32BE(seq % 0x100000000, 8);
  return n;
}

/** One frame on the wire: u32 big-endian length, then ciphertext and tag. */
function sealFrame(key, dir, seq, plain) {
  if (plain.length > MAX_PLAIN) throw new Error('quadro grande demais');
  const body = Buffer.from(new ChaCha20Poly1305(key).seal(frameNonce(dir, seq), plain));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

/** Opens one frame body (without the length). Throws if the tag does not match. */
function openBody(key, dir, seq, body) {
  if (body.length < TAG_LEN) throw new Error('quadro invalido');
  const plain = new ChaCha20Poly1305(key).open(frameNonce(dir, seq), body);
  if (plain === null) throw new Error('tag does not verify');
  return Buffer.from(plain);
}

/** Splits incoming bytes into opened frames, in order. Any failure throws. */
class FrameReader {
  constructor(key, recvDir) {
    this.key = key;
    this.dir = recvDir;
    this.seq = 0;
    this.buf = Buffer.alloc(0);
  }

  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len < TAG_LEN || len > MAX_PLAIN + TAG_LEN) throw new Error('quadro com tamanho invalido');
      if (this.buf.length < 4 + len) break;
      const plain = openBody(this.key, this.dir, this.seq, this.buf.subarray(4, 4 + len));
      this.seq++;
      out.push(plain);
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}

module.exports = {
  DIR_CLIENT,
  DIR_SERVER,
  MAX_PLAIN,
  pairingSecret,
  pairingId,
  pairingKey,
  sessionKey,
  frameNonce,
  sealFrame,
  openBody,
  FrameReader,
};
