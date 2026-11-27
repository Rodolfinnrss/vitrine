/* PS5 Screen Share - wire protocol, shared by the Electron main process, the
 * renderer and the tests. Mirrors payload/src/protocol.h.
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Ps5Protocol = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PROTO_VERSION = 1;
  const DEFAULT_PORT = 9700;
  const DISCOVERY_QUERY = 'PS5SS?';
  const DISCOVERY_REPLY = 'PS5SS! ';
  const HEADER_LEN = 8;
  const PACKET_HEADER_LEN = 16;
  const MAX_PACKET = 32 * 1024 * 1024;

  const PKT = { KEEPALIVE: 0, INFO: 1, VIDEO: 2, AUDIO: 3, STATUS: 4, PONG: 5, PAD: 6 };
  const FLAG_KEYFRAME = 0x01;
  const PAD = { UNAVAILABLE: 0, FREE: 1, YOURS: 2, BUSY: 3 };

  const TWO_32 = 4294967296;

  /**
   * Incremental parser. feed() takes whatever the socket delivered (any size,
   * any split) and returns the complete packets it now contains.
   */
  class StreamParser {
    constructor() {
      this.pending = new Uint8Array(0);
      this.headerDone = false;
    }

    feed(chunk) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (this.pending.length === 0) {
        this.pending = bytes;
      } else {
        const joined = new Uint8Array(this.pending.length + bytes.length);
        joined.set(this.pending, 0);
        joined.set(bytes, this.pending.length);
        this.pending = joined;
      }
      const out = [];
      let at = 0;
      if (!this.headerDone) {
        if (this.pending.length < HEADER_LEN) return out;
        const v = new DataView(this.pending.buffer, this.pending.byteOffset, HEADER_LEN);
        if (v.getUint32(0) !== 0x50533553) throw new Error('O servidor nao e o PS5 Screen Share');
        const version = v.getUint16(4);
        if (version !== PROTO_VERSION) throw new Error('Versao de protocolo nao suportada: ' + version);
        this.headerDone = true;
        at = HEADER_LEN;
      }
      while (this.pending.length - at >= PACKET_HEADER_LEN) {
        const v = new DataView(this.pending.buffer, this.pending.byteOffset + at, PACKET_HEADER_LEN);
        const length = v.getUint32(4);
        if (length > MAX_PACKET) throw new Error('Pacote invalido (' + length + ' bytes)');
        if (this.pending.length - at - PACKET_HEADER_LEN < length) break;
        const start = at + PACKET_HEADER_LEN;
        out.push({
          type: v.getUint8(0),
          flags: v.getUint8(1),
          pts: Number(v.getBigUint64(8)),
          payload: this.pending.slice(start, start + length),
        });
        at = start + length;
      }
      this.pending = at > 0 ? this.pending.slice(at) : this.pending;
      return out;
    }
  }

  /** HELLO line that opens a session. Unset options are left to the console. */
  function buildHello(opts) {
    const o = opts || {};
    let line = 'HELLO ' + PROTO_VERSION + ' audio=' + (o.audio === false ? 0 : 1);
    if (o.resolution) line += ' res=' + o.resolution;
    if (o.fps) line += ' fps=' + Math.trunc(o.fps);
    if (o.kbps) line += ' bitrate=' + Math.trunc(o.kbps);
    return line;
  }

  /** PAD line: seq,buttons,lx,ly,rx,ry,l2,r2 (see payload/src/pad.c). */
  function padLine(seq, state) {
    const s = state || {};
    const v = [
      ((Math.trunc(seq) % TWO_32) + TWO_32) % TWO_32,
      s.buttons >>> 0,
      clamp255(s.lx, 128),
      clamp255(s.ly, 128),
      clamp255(s.rx, 128),
      clamp255(s.ry, 128),
      clamp255(s.l2, 0),
      clamp255(s.r2, 0),
    ];
    return 'PAD ' + v.join(',');
  }

  function clamp255(value, fallback) {
    if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
    return Math.min(255, Math.max(0, Math.round(value)));
  }

  /** Reply to the UDP discovery query, or null if the text is not one. */
  function parseDiscoveryReply(text) {
    if (typeof text !== 'string' || !text.startsWith(DISCOVERY_REPLY)) return null;
    try {
      const o = JSON.parse(text.slice(DISCOVERY_REPLY.length));
      if (o.app !== 'ps5-screenshare') return null;
      return {
        ip: String(o.ip || ''),
        port: Number(o.port) || DEFAULT_PORT,
        firmware: String(o.firmware || '?'),
        clients: Number(o.clients) || 0,
        width: Number(o.width) || 0,
        height: Number(o.height) || 0,
      };
    } catch (e) {
      return null;
    }
  }

  /** One packet from a complete buffer (header and payload), or null if malformed. */
  function parsePacket(buf) {
    if (!buf || buf.length < PACKET_HEADER_LEN) return null;
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const length = v.getUint32(4);
    if (buf.length !== PACKET_HEADER_LEN + length) return null;
    return {
      type: v.getUint8(0),
      flags: v.getUint8(1),
      pts: Number(v.getBigUint64(8)),
      payload: buf.subarray(PACKET_HEADER_LEN),
    };
  }

  /** Finds the first SPS and PPS NAL units in an Annex-B access unit. */
  function extractParameterSets(au) {
    let sps = null;
    let pps = null;
    let sc = nextStartCode(au, 0);
    while (sc >= 0 && (sps === null || pps === null)) {
      const start = sc + 3;
      const next = nextStartCode(au, start);
      let end = next < 0 ? au.length : next;
      while (end > start && au[end - 1] === 0) end--; // trailing zero of a 4-byte start code
      if (start < end) {
        const type = au[start] & 0x1f;
        if (type === 7 && sps === null) sps = au.slice(start, end);
        else if (type === 8 && pps === null) pps = au.slice(start, end);
      }
      sc = next;
    }
    return sps && pps ? { sps, pps } : null;
  }

  function nextStartCode(b, from) {
    for (let i = Math.max(from, 0); i + 2 < b.length; i++) {
      if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) return i;
    }
    return -1;
  }

  /** WebCodecs codec string ("avc1.PPCCLL") from an SPS NAL unit, or null. */
  function h264CodecFromSps(sps) {
    if (!sps || sps.length < 4 || (sps[0] & 0x1f) !== 7) return null;
    const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0');
    return 'avc1.' + hex(sps[1]) + hex(sps[2]) + hex(sps[3]);
  }

  /** True for addresses inside the home network or a VPN (no warning needed). */
  function isPrivateHost(host) {
    const h = String(host || '').trim().toLowerCase();
    if (h === 'localhost' || h.endsWith('.local')) return true;
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (!m) return false; // a name we cannot check: treat as public
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT: Tailscale and similar VPNs
    return false;
  }

  return {
    PROTO_VERSION,
    DEFAULT_PORT,
    DISCOVERY_QUERY,
    DISCOVERY_REPLY,
    PKT,
    FLAG_KEYFRAME,
    PAD,
    MAX_PACKET,
    StreamParser,
    parsePacket,
    buildHello,
    padLine,
    parseDiscoveryReply,
    extractParameterSets,
    h264CodecFromSps,
    isPrivateHost,
  };
});
