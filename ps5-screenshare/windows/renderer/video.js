/* PS5 Screen Share - H.264 decoding with WebCodecs, drawn to a canvas.
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The console sends Annex-B access units with SPS/PPS before every IDR, so the
 * decoder needs no extra description. Only the newest decoded frame is drawn:
 * if the screen falls behind, old frames are dropped instead of building lag.
 */
(function (root) {
  'use strict';
  const P = root.Ps5Protocol;

  // Skip delta frames once this many are waiting to decode (about 50 ms).
  const MAX_QUEUED_DELTAS = 3;

  class VideoPlayer {
    constructor(canvas, opts) {
      const o = opts || {};
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.onNeedKey = o.onNeedKey || function () {};
      this.onFirstFrame = o.onFirstFrame || function () {};
      this.decoder = null;
      this.codec = null;
      this.waitKey = true;
      this.pending = null;
      this.raf = 0;
      this.rendered = 0;
      this.dropped = 0;
      this.errors = 0;
      this.supported = typeof VideoDecoder === 'function' && typeof EncodedVideoChunk === 'function';
      if (this.supported) this.createDecoder();
    }

    createDecoder() {
      this.decoder = new VideoDecoder({
        output: (frame) => this.onFrame(frame),
        error: (err) => this.onError(err),
      });
    }

    /** One access unit from the console. */
    push(data, ptsUs, key) {
      if (!this.decoder || this.decoder.state === 'closed') return;
      if (key) {
        const ps = P.extractParameterSets(data);
        const codec = ps ? P.h264CodecFromSps(ps.sps) : this.codec;
        if (codec && (codec !== this.codec || this.decoder.state !== 'configured')) {
          try {
            this.decoder.configure({ codec: codec, optimizeForLatency: true });
            this.codec = codec;
          } catch (err) {
            this.onError(err);
            return;
          }
        }
        if (this.decoder.state !== 'configured') return;
        this.waitKey = false;
      } else if (this.waitKey || this.decoder.state !== 'configured') {
        return;
      } else if (this.decoder.decodeQueueSize > MAX_QUEUED_DELTAS) {
        // Falling behind: skip to the next keyframe instead of lagging further.
        this.dropped++;
        this.waitKey = true;
        this.onNeedKey();
        return;
      }
      try {
        this.decoder.decode(new EncodedVideoChunk({
          type: key ? 'key' : 'delta',
          timestamp: ptsUs,
          data: data,
        }));
      } catch (err) {
        this.onError(err);
      }
    }

    onFrame(frame) {
      if (this.pending) {
        this.dropped++;
        this.pending.close();
      }
      this.pending = frame;
      if (!this.raf) this.raf = requestAnimationFrame(() => this.draw());
    }

    draw() {
      this.raf = 0;
      const frame = this.pending;
      this.pending = null;
      if (!frame) return;
      const w = frame.displayWidth;
      const h = frame.displayHeight;
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      try {
        this.ctx.drawImage(frame, 0, 0, w, h);
      } finally {
        frame.close();
      }
      this.rendered++;
      if (this.rendered === 1) this.onFirstFrame();
    }

    onError(err) {
      this.errors++;
      console.warn('decoder error', err && err.message);
      try {
        if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
      } catch (e) {
        // already closed
      }
      this.codec = null;
      this.waitKey = true;
      if (this.supported) this.createDecoder();
      this.onNeedKey();
    }

    /** Called when the connection drops: the next keyframe starts a fresh decode. */
    reset() {
      this.waitKey = true;
      if (this.pending) {
        this.pending.close();
        this.pending = null;
      }
      try {
        if (this.decoder && this.decoder.state === 'configured') this.decoder.reset();
      } catch (e) {
        // reset failed: the next keyframe reconfigures
      }
      this.codec = null;
    }
  }

  root.Ps5Video = { VideoPlayer: VideoPlayer };
})(typeof self !== 'undefined' ? self : this);
