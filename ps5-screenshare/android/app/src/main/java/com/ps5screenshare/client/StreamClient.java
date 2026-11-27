/* PS5 Screen Share - stream protocol client (plain Java, no Android APIs).
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Wire format (see payload/src/protocol.h):
 *   client: text lines, the first one is "HELLO 1 ..."
 *   server: "PS5S" u16 version u16 reserved, then packets of
 *           u8 type, u8 flags, u16 reserved, u32 length, u64 pts_us, payload
 */
package com.ps5screenshare.client;

import java.io.BufferedInputStream;
import java.io.Closeable;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;

public final class StreamClient implements Closeable {
    public static final int DEFAULT_PORT = 9700;
    public static final int PKT_KEEPALIVE = 0;
    public static final int PKT_INFO = 1;
    public static final int PKT_VIDEO = 2;
    public static final int PKT_AUDIO = 3;
    public static final int PKT_STATUS = 4;
    public static final int PKT_PONG = 5;
    public static final int FLAG_KEYFRAME = 1;
    private static final int MAX_PACKET = 32 * 1024 * 1024;

    public interface Listener {
        void onInfo(String json);
        void onVideo(byte[] data, long ptsUs, boolean keyframe);
        void onAudio(byte[] data, long ptsUs);
        void onStatus(String text);
        void onPong(String token);
    }

    private final Socket socket;
    private final DataInputStream in;
    private final OutputStream out;
    private volatile boolean closed;
    private long bytesReceived;

    /** Connects and sends the HELLO line. Blocks; call off the UI thread. */
    public StreamClient(String host, int port, String hello, int connectTimeoutMs) throws IOException {
        socket = new Socket();
        socket.setTcpNoDelay(true);
        socket.setReceiveBufferSize(2 * 1024 * 1024);
        socket.connect(new InetSocketAddress(host, port), connectTimeoutMs);
        // The server sends a keepalive every second; 6 s of silence = dead link.
        socket.setSoTimeout(6000);
        in = new DataInputStream(new BufferedInputStream(socket.getInputStream(), 256 * 1024));
        out = socket.getOutputStream();
        send(hello);
        byte[] magic = new byte[8];
        in.readFully(magic);
        if (magic[0] != 'P' || magic[1] != 'S' || magic[2] != '5' || magic[3] != 'S') {
            close();
            throw new IOException("O servidor nao e o PS5 Screen Share");
        }
    }

    public static String hello(boolean audio, String resolution, int fps, int kbps) {
        StringBuilder sb = new StringBuilder("HELLO 1 audio=").append(audio ? 1 : 0);
        if (resolution != null && !resolution.isEmpty()) sb.append(" res=").append(resolution);
        if (fps > 0) sb.append(" fps=").append(fps);
        if (kbps > 0) sb.append(" bitrate=").append(kbps);
        return sb.toString();
    }

    /** Sends one command line. Thread safe; performs network I/O. */
    public void send(String line) throws IOException {
        byte[] b = (line + "\n").getBytes(StandardCharsets.UTF_8);
        synchronized (out) {
            out.write(b);
            out.flush();
        }
    }

    public long bytesReceived() {
        return bytesReceived;
    }

    /** Reads packets until the connection ends; always throws at the end. */
    public void run(Listener l) throws IOException {
        try {
            while (!closed) {
                int type = in.readUnsignedByte();
                int flags = in.readUnsignedByte();
                in.readUnsignedShort();
                long length = in.readInt() & 0xffffffffL;
                long pts = in.readLong();
                if (length > MAX_PACKET) throw new IOException("pacote invalido (" + length + " bytes)");
                byte[] payload = new byte[(int) length];
                in.readFully(payload);
                bytesReceived += 16 + length;
                switch (type) {
                    case PKT_VIDEO:
                        l.onVideo(payload, pts, (flags & FLAG_KEYFRAME) != 0);
                        break;
                    case PKT_AUDIO:
                        l.onAudio(payload, pts);
                        break;
                    case PKT_INFO:
                        l.onInfo(new String(payload, StandardCharsets.UTF_8));
                        break;
                    case PKT_STATUS:
                        l.onStatus(new String(payload, StandardCharsets.UTF_8));
                        break;
                    case PKT_PONG:
                        l.onPong(new String(payload, StandardCharsets.UTF_8));
                        break;
                    default:
                        break; // keepalive and future packet types
                }
            }
            throw new EOFException("fechado");
        } catch (SocketTimeoutException e) {
            throw new IOException("Sem resposta do PS5", e);
        }
    }

    @Override
    public void close() {
        closed = true;
        try {
            socket.close();
        } catch (IOException ignored) {
        }
    }
}
