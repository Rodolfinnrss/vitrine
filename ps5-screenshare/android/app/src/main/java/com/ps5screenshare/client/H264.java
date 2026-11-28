/* PS5 Screen Share - small H.264 Annex-B helpers.
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later */
package com.ps5screenshare.client;

import java.util.Arrays;

final class H264 {
    private H264() {}

    /** Offset of the next start code (00 00 01) at or after from, or -1. */
    static int nextStartCode(byte[] b, int from) {
        for (int i = Math.max(from, 0); i + 2 < b.length; i++) {
            if (b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 1) return i;
        }
        return -1;
    }

    /** First SPS and PPS NAL units (without start codes), or null. */
    static byte[][] parameterSets(byte[] au) {
        byte[] sps = null, pps = null;
        int sc = nextStartCode(au, 0);
        while (sc >= 0 && (sps == null || pps == null)) {
            int start = sc + 3;
            int next = nextStartCode(au, start);
            int end = next < 0 ? au.length : next;
            // A 4-byte start code leaves a trailing zero on the previous NAL.
            while (end > start && au[end - 1] == 0) end--;
            if (start < end) {
                int type = au[start] & 0x1f;
                if (type == 7 && sps == null) sps = Arrays.copyOfRange(au, start, end);
                else if (type == 8 && pps == null) pps = Arrays.copyOfRange(au, start, end);
            }
            sc = next;
        }
        return sps != null && pps != null ? new byte[][] {sps, pps} : null;
    }

    static byte[] withStartCode(byte[] nal) {
        byte[] out = new byte[nal.length + 4];
        out[3] = 1;
        System.arraycopy(nal, 0, out, 4, nal.length);
        return out;
    }
}
