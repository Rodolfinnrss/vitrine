/* PS5 Screen Share - low-latency PCM playback (48 kHz, stereo, s16le).
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later */
package com.ps5screenshare.client;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.Build;
import android.util.Log;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

final class AudioPlayer {
    private static final String TAG = "PS5SS.Audio";
    private static final int RATE = 48000;
    /** Blocks of 1024 frames (21.3 ms). More than this queued = too much delay. */
    private static final int MAX_QUEUED = 5;

    private final ArrayBlockingQueue<byte[]> queue = new ArrayBlockingQueue<>(32);
    private volatile boolean running;
    private volatile boolean muted;
    private Thread thread;
    private AudioTrack track;

    void start() {
        running = true;
        thread = new Thread(this::loop, "ps5ss-audio");
        thread.setPriority(Thread.MAX_PRIORITY);
        thread.start();
    }

    void stop() {
        running = false;
        if (thread != null) {
            thread.interrupt();
            try {
                thread.join(1000);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
        queue.clear();
    }

    void setMuted(boolean m) {
        muted = m;
        if (m) queue.clear();
    }

    void submit(byte[] pcm) {
        if (!running || muted) return;
        while (queue.size() >= MAX_QUEUED) queue.poll(); // keep latency bounded
        queue.offer(pcm);
    }

    @SuppressWarnings("deprecation")
    private AudioTrack createTrack() {
        int min = AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_STEREO,
                AudioFormat.ENCODING_PCM_16BIT);
        int size = Math.max(min, 4096 * 2);
        if (Build.VERSION.SDK_INT >= 26) {
            return new AudioTrack.Builder()
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_GAME)
                            .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
                            .build())
                    .setAudioFormat(new AudioFormat.Builder()
                            .setSampleRate(RATE)
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
                            .build())
                    .setBufferSizeInBytes(size)
                    .setTransferMode(AudioTrack.MODE_STREAM)
                    .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
                    .build();
        }
        return new AudioTrack(AudioManager.STREAM_MUSIC, RATE, AudioFormat.CHANNEL_OUT_STEREO,
                AudioFormat.ENCODING_PCM_16BIT, size, AudioTrack.MODE_STREAM);
    }

    private void loop() {
        try {
            track = createTrack();
            track.play();
            while (running) {
                byte[] pcm = queue.poll(200, TimeUnit.MILLISECONDS);
                if (pcm == null || muted) continue;
                int off = 0;
                while (off < pcm.length && running) {
                    int n = track.write(pcm, off, pcm.length - off);
                    if (n <= 0) break;
                    off += n;
                }
            }
        } catch (InterruptedException ignored) {
            // stopping
        } catch (RuntimeException e) {
            Log.e(TAG, "audio output failed", e);
        } finally {
            if (track != null) {
                try {
                    track.pause();
                    track.flush();
                    track.release();
                } catch (RuntimeException ignored) {
                }
                track = null;
            }
        }
    }
}
