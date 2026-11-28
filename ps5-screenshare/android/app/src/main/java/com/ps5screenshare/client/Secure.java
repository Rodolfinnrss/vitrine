/* PS5 Screen Share - end-to-end sealing for the relay (relay/PROTOCOL.md).
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ChaCha20-Poly1305 (RFC 8439) written out here: javax.crypto only has it from
 * Android 9, and the app runs from Android 5. Poly1305 uses 26-bit limbs (the
 * donna layout), so no big-number arithmetic runs per block. Tested against the
 * shared vectors in SecureVectors.java.
 */
package com.ps5screenshare.client;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;

final class Secure {
    static final int DIR_CLIENT = 0x43; // app -> console
    static final int DIR_SERVER = 0x53; // console -> app
    static final int TAG_LEN = 16;
    static final int MAX_PLAIN = 8 * 1024 * 1024;

    private Secure() {}

    // ------------------------------------------------------- pairing --

    static byte[] sha256(byte[]... parts) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            for (byte[] p : parts) md.update(p);
            return md.digest();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** 32 hex characters; dashes, spaces and case are ignored. */
    static byte[] pairingSecret(String text) {
        String raw = text == null ? "" : text.replaceAll("[-\\s]", "");
        if (!raw.matches("[0-9a-fA-F]{32}")) {
            throw new IllegalArgumentException("O código de pareamento tem 32 caracteres hexadecimais");
        }
        return hexToBytes(raw);
    }

    static String pairingId(byte[] secret) {
        return bytesToHex(Arrays.copyOf(sha256(ascii("ps5ss-id-v1"), secret), 8));
    }

    static byte[] pairingKey(byte[] secret) {
        return sha256(ascii("ps5ss-key-v1"), secret);
    }

    static byte[] sessionKey(byte[] key, byte[] salt) {
        return sha256(ascii("ps5ss-sess-v1"), key, salt);
    }

    static byte[] ascii(String s) {
        return s.getBytes(StandardCharsets.US_ASCII);
    }

    static byte[] hexToBytes(String hex) {
        byte[] out = new byte[hex.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(hex.substring(2 * i, 2 * i + 2), 16);
        }
        return out;
    }

    static String bytesToHex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(String.format("%02x", x & 0xff));
        return sb.toString();
    }

    // -------------------------------------------------------- frames --

    static byte[] nonce(int dir, long seq) {
        byte[] n = new byte[12];
        n[0] = (byte) dir;
        for (int i = 0; i < 8; i++) n[4 + i] = (byte) (seq >>> (56 - 8 * i));
        return n;
    }

    /** One frame on the wire: u32 big-endian length, then ciphertext and tag. */
    static byte[] seal(byte[] key, int dir, long seq, byte[] plain) {
        byte[] body = aeadSeal(key, nonce(dir, seq), plain);
        byte[] frame = new byte[4 + body.length];
        frame[0] = (byte) (body.length >>> 24);
        frame[1] = (byte) (body.length >>> 16);
        frame[2] = (byte) (body.length >>> 8);
        frame[3] = (byte) body.length;
        System.arraycopy(body, 0, frame, 4, body.length);
        return frame;
    }

    /** Opens one frame body. Throws IOException if the tag does not match. */
    static byte[] open(byte[] key, int dir, long seq, byte[] body) throws IOException {
        if (body.length < TAG_LEN) throw new IOException("quadro invalido");
        byte[] plain = aeadOpen(key, nonce(dir, seq), body);
        if (plain == null) throw new IOException("Conexão recusada: o código de pareamento não confere");
        return plain;
    }

    // ------------------------------------------------------------ AEAD --

    static byte[] aeadSeal(byte[] key, byte[] nonce, byte[] plain) {
        byte[] polyKey = polyKey(key, nonce);
        byte[] out = new byte[plain.length + TAG_LEN];
        chachaXor(key, nonce, 1, plain, 0, plain.length, out, 0);
        byte[] tag = macFor(polyKey, out, plain.length);
        System.arraycopy(tag, 0, out, plain.length, TAG_LEN);
        return out;
    }

    /** Returns the plaintext, or null if the tag does not verify. */
    static byte[] aeadOpen(byte[] key, byte[] nonce, byte[] body) {
        int n = body.length - TAG_LEN;
        byte[] tag = macFor(polyKey(key, nonce), body, n);
        int diff = 0;
        for (int i = 0; i < TAG_LEN; i++) diff |= tag[i] ^ body[n + i];
        if (diff != 0) return null;
        byte[] plain = new byte[n];
        chachaXor(key, nonce, 1, body, 0, n, plain, 0);
        return plain;
    }

    /** Poly1305 input: ciphertext, padded to 16, then two 64-bit little-endian lengths (no AAD). */
    private static byte[] macFor(byte[] polyKey, byte[] ct, int len) {
        Poly1305 p = new Poly1305(polyKey);
        p.update(ct, 0, len);
        if (len % 16 != 0) p.update(new byte[16 - len % 16], 0, 16 - len % 16);
        byte[] lens = new byte[16];
        for (int i = 0; i < 8; i++) lens[8 + i] = (byte) ((long) len >>> (8 * i));
        p.update(lens, 0, 16);
        return p.finish();
    }

    private static byte[] polyKey(byte[] key, byte[] nonce) {
        int[] st = new int[16], ks = new int[16];
        chachaInit(st, key, nonce, 0);
        chachaBlock(st, ks);
        byte[] out = new byte[32];
        for (int i = 0; i < 8; i++) putLe32(out, 4 * i, ks[i]);
        return out;
    }

    // ---------------------------------------------------------- ChaCha20 --

    private static int le32i(byte[] b, int off) {
        return (b[off] & 0xff) | (b[off + 1] & 0xff) << 8 | (b[off + 2] & 0xff) << 16 | (b[off + 3] & 0xff) << 24;
    }

    private static void putLe32(byte[] b, int off, int v) {
        b[off] = (byte) v;
        b[off + 1] = (byte) (v >>> 8);
        b[off + 2] = (byte) (v >>> 16);
        b[off + 3] = (byte) (v >>> 24);
    }

    private static void chachaInit(int[] st, byte[] key, byte[] nonce, int counter) {
        st[0] = 0x61707865;
        st[1] = 0x3320646e;
        st[2] = 0x79622d32;
        st[3] = 0x6b206574;
        for (int i = 0; i < 8; i++) st[4 + i] = le32i(key, 4 * i);
        st[12] = counter;
        for (int i = 0; i < 3; i++) st[13 + i] = le32i(nonce, 4 * i);
    }

    private static int rotl(int v, int n) {
        return (v << n) | (v >>> (32 - n));
    }

    private static void qr(int[] x, int a, int b, int c, int d) {
        x[a] += x[b]; x[d] ^= x[a]; x[d] = rotl(x[d], 16);
        x[c] += x[d]; x[b] ^= x[c]; x[b] = rotl(x[b], 12);
        x[a] += x[b]; x[d] ^= x[a]; x[d] = rotl(x[d], 8);
        x[c] += x[d]; x[b] ^= x[c]; x[b] = rotl(x[b], 7);
    }

    private static void chachaBlock(int[] in, int[] out) {
        int[] x = in.clone();
        for (int i = 0; i < 10; i++) {
            qr(x, 0, 4, 8, 12); qr(x, 1, 5, 9, 13); qr(x, 2, 6, 10, 14); qr(x, 3, 7, 11, 15);
            qr(x, 0, 5, 10, 15); qr(x, 1, 6, 11, 12); qr(x, 2, 7, 8, 13); qr(x, 3, 4, 9, 14);
        }
        for (int i = 0; i < 16; i++) out[i] = x[i] + in[i];
    }

    static void chachaXor(byte[] key, byte[] nonce, int counter, byte[] in, int inOff, int len,
                          byte[] out, int outOff) {
        int[] st = new int[16], ks = new int[16];
        chachaInit(st, key, nonce, counter);
        byte[] block = new byte[64];
        for (int off = 0; off < len; off += 64) {
            chachaBlock(st, ks);
            for (int i = 0; i < 16; i++) putLe32(block, 4 * i, ks[i]);
            int n = Math.min(64, len - off);
            for (int i = 0; i < n; i++) out[outOff + off + i] = (byte) (in[inOff + off + i] ^ block[i]);
            st[12]++;
        }
    }

    // ------------------------------------------------------- Poly1305 --

    /** poly1305-donna, 32-bit limbs of 26 bits, held in longs. */
    static final class Poly1305 {
        private final long r0, r1, r2, r3, r4, s1, s2, s3, s4;
        private final long p0, p1, p2, p3;
        private long h0, h1, h2, h3, h4;
        private final byte[] buf = new byte[16];
        private int leftover;

        Poly1305(byte[] key) {
            r0 = le32(key, 0) & 0x3ffffff;
            r1 = (le32(key, 3) >>> 2) & 0x3ffff03;
            r2 = (le32(key, 6) >>> 4) & 0x3ffc0ff;
            r3 = (le32(key, 9) >>> 6) & 0x3f03fff;
            r4 = (le32(key, 12) >>> 8) & 0x00fffff;
            s1 = r1 * 5;
            s2 = r2 * 5;
            s3 = r3 * 5;
            s4 = r4 * 5;
            p0 = le32(key, 16);
            p1 = le32(key, 20);
            p2 = le32(key, 24);
            p3 = le32(key, 28);
        }

        private static long le32(byte[] b, int off) {
            return ((b[off] & 0xffL)) | ((b[off + 1] & 0xffL) << 8) | ((b[off + 2] & 0xffL) << 16)
                    | ((b[off + 3] & 0xffL) << 24);
        }

        private void blocks(byte[] m, int off, int bytes, long hibit) {
            long h0 = this.h0, h1 = this.h1, h2 = this.h2, h3 = this.h3, h4 = this.h4;
            while (bytes >= 16) {
                h0 += le32(m, off) & 0x3ffffff;
                h1 += (le32(m, off + 3) >>> 2) & 0x3ffffff;
                h2 += (le32(m, off + 6) >>> 4) & 0x3ffffff;
                h3 += (le32(m, off + 9) >>> 6) & 0x3ffffff;
                h4 += (le32(m, off + 12) >>> 8) | hibit;

                long d0 = h0 * r0 + h1 * s4 + h2 * s3 + h3 * s2 + h4 * s1;
                long d1 = h0 * r1 + h1 * r0 + h2 * s4 + h3 * s3 + h4 * s2;
                long d2 = h0 * r2 + h1 * r1 + h2 * r0 + h3 * s4 + h4 * s3;
                long d3 = h0 * r3 + h1 * r2 + h2 * r1 + h3 * r0 + h4 * s4;
                long d4 = h0 * r4 + h1 * r3 + h2 * r2 + h3 * r1 + h4 * r0;

                long c = d0 >>> 26; h0 = d0 & 0x3ffffff;
                d1 += c; c = d1 >>> 26; h1 = d1 & 0x3ffffff;
                d2 += c; c = d2 >>> 26; h2 = d2 & 0x3ffffff;
                d3 += c; c = d3 >>> 26; h3 = d3 & 0x3ffffff;
                d4 += c; c = d4 >>> 26; h4 = d4 & 0x3ffffff;
                h0 += c * 5; c = h0 >>> 26; h0 &= 0x3ffffff;
                h1 += c;

                off += 16;
                bytes -= 16;
            }
            this.h0 = h0; this.h1 = h1; this.h2 = h2; this.h3 = h3; this.h4 = h4;
        }

        void update(byte[] m, int off, int len) {
            if (leftover > 0) {
                int want = Math.min(16 - leftover, len);
                System.arraycopy(m, off, buf, leftover, want);
                leftover += want;
                off += want;
                len -= want;
                if (leftover < 16) return;
                blocks(buf, 0, 16, 1L << 24);
                leftover = 0;
            }
            int full = len & ~15;
            if (full > 0) {
                blocks(m, off, full, 1L << 24);
                off += full;
                len -= full;
            }
            if (len > 0) {
                System.arraycopy(m, off, buf, 0, len);
                leftover = len;
            }
        }

        byte[] finish() {
            long h0 = this.h0, h1 = this.h1, h2 = this.h2, h3 = this.h3, h4 = this.h4;
            if (leftover > 0) {
                int i = leftover;
                buf[i++] = 1;
                for (; i < 16; i++) buf[i] = 0;
                blocks(buf, 0, 16, 0);
                h0 = this.h0; h1 = this.h1; h2 = this.h2; h3 = this.h3; h4 = this.h4;
            }
            long c = h1 >>> 26; h1 &= 0x3ffffff;
            h2 += c; c = h2 >>> 26; h2 &= 0x3ffffff;
            h3 += c; c = h3 >>> 26; h3 &= 0x3ffffff;
            h4 += c; c = h4 >>> 26; h4 &= 0x3ffffff;
            h0 += c * 5; c = h0 >>> 26; h0 &= 0x3ffffff;
            h1 += c;

            long g0 = h0 + 5; c = g0 >>> 26; g0 &= 0x3ffffff;
            long g1 = h1 + c; c = g1 >>> 26; g1 &= 0x3ffffff;
            long g2 = h2 + c; c = g2 >>> 26; g2 &= 0x3ffffff;
            long g3 = h3 + c; c = g3 >>> 26; g3 &= 0x3ffffff;
            long g4 = h4 + c - (1L << 26);

            long mask = ((g4 & 0xffffffffL) >>> 31) - 1; // all ones when h >= p
            g0 &= mask; g1 &= mask; g2 &= mask; g3 &= mask; g4 &= mask;
            mask = ~mask;
            h0 = (h0 & mask) | g0;
            h1 = (h1 & mask) | g1;
            h2 = (h2 & mask) | g2;
            h3 = (h3 & mask) | g3;
            h4 = (h4 & mask) | g4;

            h0 = (h0 | (h1 << 26)) & 0xffffffffL;
            h1 = ((h1 >>> 6) | (h2 << 20)) & 0xffffffffL;
            h2 = ((h2 >>> 12) | (h3 << 14)) & 0xffffffffL;
            h3 = ((h3 >>> 18) | (h4 << 8)) & 0xffffffffL;

            long f = h0 + p0; h0 = f & 0xffffffffL;
            f = h1 + p1 + (f >>> 32); h1 = f & 0xffffffffL;
            f = h2 + p2 + (f >>> 32); h2 = f & 0xffffffffL;
            f = h3 + p3 + (f >>> 32); h3 = f & 0xffffffffL;

            byte[] mac = new byte[16];
            putLe32(mac, 0, (int) h0);
            putLe32(mac, 4, (int) h1);
            putLe32(mac, 8, (int) h2);
            putLe32(mac, 12, (int) h3);
            return mac;
        }
    }
}
