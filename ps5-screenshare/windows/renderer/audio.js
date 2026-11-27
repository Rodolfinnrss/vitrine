/* PS5 Screen Share - PCM playback (48 kHz stereo, signed 16-bit little endian).
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Each packet is one 1024-frame block. Blocks are scheduled back to back; a
 * small cushion absorbs jitter, and anything beyond ~250 ms is dropped so the
 * sound never falls behind the picture.
 */
(function (root) {
  'use strict';

  const RATE = 48000;
  const CUSHION_S = 0.06;
  const MAX_AHEAD_S = 0.25;

  class AudioPlayer {
    constructor() {
      this.ctx = null;
      this.gain = null;
      this.next = 0;
      this.muted = false;
      this.dropped = 0;
    }

    /** Must run from a user gesture (Chromium blocks audio otherwise). */
    start() {
      if (this.ctx && this.ctx.state !== 'closed') {
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return;
      }
      if (typeof AudioContext !== 'function') return;
      this.ctx = new AudioContext({ sampleRate: RATE });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.muted ? 0 : 1;
      this.gain.connect(this.ctx.destination);
      this.next = 0;
    }

    setMuted(m) {
      this.muted = !!m;
      if (this.gain) this.gain.gain.value = this.muted ? 0 : 1;
    }

    push(bytes) {
      if (!this.ctx || this.ctx.state === 'closed') return;
      const frames = bytes.length >> 2; // 2 channels x 2 bytes
      if (frames === 0) return;
      const buffer = this.ctx.createBuffer(2, frames, RATE);
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < frames; i++) {
        left[i] = view.getInt16(i * 4, true) / 32768;
        right[i] = view.getInt16(i * 4 + 2, true) / 32768;
      }
      const now = this.ctx.currentTime;
      if (this.next < now + 0.02) this.next = now + CUSHION_S; // start or underrun
      if (this.next - now > MAX_AHEAD_S) {
        this.dropped++;
        return;
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.gain);
      src.start(this.next);
      this.next += frames / RATE;
    }

    close() {
      if (this.ctx && this.ctx.state !== 'closed') this.ctx.close();
      this.ctx = null;
      this.gain = null;
    }
  }

  root.Ps5Audio = { AudioPlayer: AudioPlayer };
})(typeof self !== 'undefined' ? self : this);
