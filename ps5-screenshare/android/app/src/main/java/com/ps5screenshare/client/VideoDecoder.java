/* PS5 Screen Share - low-latency H.264 decoding onto a Surface.
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * One thread owns the MediaCodec: it feeds queued access units and renders
 * output buffers as soon as they appear (older ready frames are dropped so the
 * picture never lags behind). A backlog or decoder error makes the client
 * wait for the next IDR and ask the console for one.
 */
package com.ps5screenshare.client;

import android.media.MediaCodec;
import android.media.MediaFormat;
import android.os.Build;
import android.util.Log;
import android.view.Surface;

import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

final class VideoDecoder {
    private static final String TAG = "PS5SS.Video";
    private static final String MIME = "video/avc";
    /** Frames waiting for the decoder beyond this are a backlog (~100 ms at 60 fps). */
    private static final int MAX_BACKLOG = 6;

    interface Callback {
        void onVideoSize(int width, int height);
        void onFrameRendered();
        void onNeedKeyframe();
        void onDecoderError(String message);
    }

    private static final class Frame {
        final byte[] data;
        final long ptsUs;
        final boolean key;

        Frame(byte[] data, long ptsUs, boolean key) {
            this.data = data;
            this.ptsUs = ptsUs;
            this.key = key;
        }
    }

    private final Surface surface;
    private final Callback cb;
    private final ArrayBlockingQueue<Frame> queue = new ArrayBlockingQueue<>(64);
    private volatile boolean running;
    private volatile boolean waitKey = true;
    private volatile int hintWidth = 1920, hintHeight = 1080, hintFps = 60;
    private volatile int droppedFrames;
    private Thread thread;

    // Owned by the decoder thread.
    private MediaCodec codec;
    private byte[] configuredSps;
    private int configuredWidth, configuredHeight;

    VideoDecoder(Surface surface, Callback cb) {
        this.surface = surface;
        this.cb = cb;
    }

    void setStreamHint(int width, int height, int fps) {
        if (width > 0 && height > 0) {
            hintWidth = width;
            hintHeight = height;
        }
        if (fps > 0) hintFps = fps;
    }

    int droppedFrames() {
        return droppedFrames;
    }

    void start() {
        running = true;
        thread = new Thread(this::loop, "ps5ss-decoder");
        thread.setPriority(Thread.MAX_PRIORITY);
        thread.start();
    }

    void stop() {
        running = false;
        if (thread != null) {
            thread.interrupt();
            try {
                thread.join(2000);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
        queue.clear();
    }

    /** Called from the network thread for every received access unit. */
    void submit(byte[] data, long ptsUs, boolean key) {
        if (!running) return;
        if (waitKey) {
            if (!key) return;
            waitKey = false;
        }
        if (!key && queue.size() >= MAX_BACKLOG) {
            resync();
            return;
        }
        if (key && queue.size() >= MAX_BACKLOG) queue.clear(); // jump ahead to the IDR
        if (!queue.offer(new Frame(data, ptsUs, key))) resync();
    }

    private void resync() {
        queue.clear();
        waitKey = true;
        droppedFrames++;
        cb.onNeedKeyframe();
    }

    private void loop() {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        try {
            while (running) {
                Frame f = queue.poll();
                if (f != null) feed(f);
                if (codec == null) {
                    if (f == null) {
                        Frame next = queue.poll(20, TimeUnit.MILLISECONDS);
                        if (next != null) feed(next);
                    }
                    continue;
                }
                drain(info, f == null && queue.isEmpty() ? 4000 : 0);
            }
        } catch (InterruptedException ignored) {
            // stopping
        } finally {
            releaseCodec();
        }
    }

    private void feed(Frame f) {
        try {
            if (f.key) {
                byte[][] ps = H264.parameterSets(f.data);
                if (ps != null && (codec == null || !Arrays.equals(ps[0], configuredSps)
                        || configuredWidth != hintWidth || configuredHeight != hintHeight)) {
                    configure(ps[0], ps[1]);
                }
            }
            if (codec == null) return;
            int idx = codec.dequeueInputBuffer(20000);
            if (idx < 0) {
                Log.w(TAG, "decoder input stalled; resync");
                resync();
                return;
            }
            ByteBuffer b = codec.getInputBuffer(idx);
            if (b == null || f.data.length > b.capacity()) {
                codec.queueInputBuffer(idx, 0, 0, f.ptsUs, 0);
                Log.w(TAG, "frame of " + f.data.length + " bytes does not fit the input buffer");
                resync();
                return;
            }
            b.clear();
            b.put(f.data);
            codec.queueInputBuffer(idx, 0, f.data.length, f.ptsUs, 0);
        } catch (RuntimeException e) {
            Log.e(TAG, "decode failed", e);
            releaseCodec();
            resync();
            cb.onDecoderError(e.getClass().getSimpleName());
        }
    }

    private void drain(MediaCodec.BufferInfo info, long timeoutUs) {
        try {
            int pending = -1;
            for (;;) {
                int idx = codec.dequeueOutputBuffer(info, pending < 0 ? timeoutUs : 0);
                if (idx >= 0) {
                    if (pending >= 0) {
                        codec.releaseOutputBuffer(pending, false); // a newer frame is ready
                        droppedFrames++;
                    }
                    pending = idx;
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break;
                } else if (idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat fmt = codec.getOutputFormat();
                    int w = fmt.getInteger(MediaFormat.KEY_WIDTH);
                    int h = fmt.getInteger(MediaFormat.KEY_HEIGHT);
                    if (fmt.containsKey("crop-right") && fmt.containsKey("crop-left")) {
                        w = fmt.getInteger("crop-right") - fmt.getInteger("crop-left") + 1;
                    }
                    if (fmt.containsKey("crop-bottom") && fmt.containsKey("crop-top")) {
                        h = fmt.getInteger("crop-bottom") - fmt.getInteger("crop-top") + 1;
                    }
                    cb.onVideoSize(w, h);
                } else {
                    break; // try again later / buffers changed
                }
            }
            if (pending >= 0) {
                codec.releaseOutputBuffer(pending, true);
                cb.onFrameRendered();
            }
        } catch (RuntimeException e) {
            Log.e(TAG, "output failed", e);
            releaseCodec();
            resync();
            cb.onDecoderError(e.getClass().getSimpleName());
        }
    }

    private void configure(byte[] sps, byte[] pps) {
        releaseCodec();
        int w = hintWidth, h = hintHeight;
        try {
            codec = MediaCodec.createDecoderByType(MIME);
            try {
                codec.configure(format(w, h, sps, pps, true), surface, null, 0);
            } catch (RuntimeException e) {
                Log.w(TAG, "configure with low-latency options failed, retrying plain", e);
                codec.release();
                codec = MediaCodec.createDecoderByType(MIME);
                codec.configure(format(w, h, sps, pps, false), surface, null, 0);
            }
            codec.start();
            configuredSps = sps;
            configuredWidth = w;
            configuredHeight = h;
            Log.i(TAG, "decoder " + codec.getName() + " configured for " + w + "x" + h);
        } catch (Exception e) {
            Log.e(TAG, "cannot create decoder", e);
            releaseCodec();
            cb.onDecoderError("Decodificador H.264 indisponivel: " + e.getMessage());
        }
    }

    private MediaFormat format(int w, int h, byte[] sps, byte[] pps, boolean lowLatency) {
        MediaFormat f = MediaFormat.createVideoFormat(MIME, w, h);
        f.setByteBuffer("csd-0", ByteBuffer.wrap(H264.withStartCode(sps)));
        f.setByteBuffer("csd-1", ByteBuffer.wrap(H264.withStartCode(pps)));
        f.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, Math.max(2 * 1024 * 1024, w * h));
        if (lowLatency) {
            if (Build.VERSION.SDK_INT >= 30) f.setInteger(MediaFormat.KEY_LOW_LATENCY, 1);
            if (Build.VERSION.SDK_INT >= 23) {
                f.setInteger(MediaFormat.KEY_PRIORITY, 0);
                f.setInteger(MediaFormat.KEY_OPERATING_RATE, hintFps);
            }
            // Vendor switches that disable output reordering/buffering.
            f.setInteger("vendor.qti-ext-dec-low-latency.enable", 1);
            f.setInteger("vendor.qti-ext-dec-picture-order.enable", 1);
            f.setInteger("vendor.rtc-ext-dec-low-latency.enable", 1);
            f.setInteger("vendor.low-latency.enable", 1);
        }
        return f;
    }

    private void releaseCodec() {
        if (codec == null) return;
        try {
            codec.stop();
        } catch (RuntimeException ignored) {
        }
        try {
            codec.release();
        } catch (RuntimeException ignored) {
        }
        codec = null;
        configuredSps = null;
    }
}
