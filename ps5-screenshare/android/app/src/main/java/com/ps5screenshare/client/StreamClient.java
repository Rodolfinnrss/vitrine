/* PS5 Screen Share - stream protocol client (plain Java, no Android APIs).
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Two ways in:
 *   LAN:   straight to the console. Text lines out; "PS5S" header, then packets.
 *   Relay: to the relay, which hands the connection to the console. Everything
 *          after the relay's "OK" is sealed with the pairing code (relay/PROTOCOL.md).
 *
 * Packet layout (see payload/src/protocol.h): u8 type, u8 flags, u16 reserved,
 * u32 length, u64 pts_us, payload.
 */
package com.ps5screenshare.client;

import java.io.BufferedInputStream;
import java.io.Closeable;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;

public final class StreamClient implements Closeable {
    public static final int DEFAULT_PORT = 9700;
    public static final int RELAY_PORT = 9800;
    public static final int PKT_KEEPALIVE = 0;
    public static final int PKT_INFO = 1;
    public static final int PKT_VIDEO = 2;
    public static final int PKT_AUDIO = 3;
    public static final int PKT_STATUS = 4;
    public static final int PKT_PONG = 5;
    public static final int PKT_PAD = 6;
    /** PKT_PAD values (see payload/src/pad.h). */
    public static final int PAD_UNAVAILABLE = 0;
    public static final int PAD_FREE = 1;
    public static final int PAD_YOURS = 2;
    public static final int PAD_BUSY = 3;
    public static final int FLAG_KEYFRAME = 1;
    private static final int MAX_PACKET = 32 * 1024 * 1024;

    public interface Listener {
        void onInfo(String json);
        void onVideo(byte[] data, long ptsUs, boolean keyframe);
        void onAudio(byte[] data, long ptsUs);
        void onStatus(String text);
        void onPong(String token);
        /** One of the PAD_* values above. */
        void onPad(int state);
    }

    private final Socket socket;
    private final DataInputStream in;
    private final OutputStream out;
    /** Non-null for relay sessions: the session key and sequence numbers. */
    private final byte[] sessionKey;
    private long txSeq;
    private long rxSeq;
    private volatile boolean closed;
    private long bytesReceived;

    private StreamClient(Socket socket, byte[] sessionKey) throws IOException {
        this.socket = socket;
        this.sessionKey = sessionKey;
        InputStream raw = socket.getInputStream();
        this.in = new DataInputStream(new BufferedInputStream(raw, 256 * 1024));
        this.out = socket.getOutputStream();
    }

    /** LAN: connects and sends the HELLO line. Blocks; call off the UI thread. */
    public static StreamClient direct(String host, int port, String hello, int connectTimeoutMs) throws IOException {
        Socket s = open(host, port, connectTimeoutMs);
        StreamClient c = new StreamClient(s, null);
        try {
            c.writeText(hello + "\n");
            byte[] magic = new byte[8];
            c.in.readFully(magic);
            if (magic[0] != 'P' || magic[1] != 'S' || magic[2] != '5' || magic[3] != 'S') {
                throw new IOException("O servidor nao e o PS5 Screen Share");
            }
            return c;
        } catch (IOException e) {
            c.close();
            throw e;
        }
    }

    /**
     * Through the relay. secret: the 16-byte pairing secret (Secure.pairingSecret).
     * Blocks; call off the UI thread.
     */
    public static StreamClient viaRelay(String relayHost, int relayPort, byte[] secret, String hello,
                                        int connectTimeoutMs) throws IOException {
        Socket s = open(relayHost, relayPort, connectTimeoutMs);
        try {
            StreamClient plain = new StreamClient(s, null);
            plain.writeText("SUB " + Secure.pairingId(secret) + "\n");
            String answer = plain.readLine();
            if (!"OK".equals(answer)) throw new IOException(relayMessage(answer));
            String salt = plain.readLine();
            if (!salt.matches("SALT [0-9a-f]{32}")) {
                throw new IOException("O PS5 nao iniciou a sessao corretamente");
            }
            byte[] key = Secure.sessionKey(Secure.pairingKey(secret), Secure.hexToBytes(salt.substring(5)));
            StreamClient c = new StreamClient(s, key);
            c.writeSealed(hello.getBytes(StandardCharsets.UTF_8));
            byte[] header = c.readSealed();
            if (header.length != 8 || header[0] != 'P' || header[1] != 'S' || header[2] != '5' || header[3] != 'S') {
                throw new IOException("Stream invalido");
            }
            return c;
        } catch (IOException e) {
            s.close();
            throw e;
        }
    }

    private static Socket open(String host, int port, int connectTimeoutMs) throws IOException {
        Socket s = new Socket();
        s.setTcpNoDelay(true);
        s.setReceiveBufferSize(2 * 1024 * 1024);
        s.connect(new InetSocketAddress(host, port), connectTimeoutMs);
        // The console sends a keepalive every second; 6 s of silence means the link is dead.
        s.setSoTimeout(6000);
        return s;
    }

    static String relayMessage(String code) {
        switch (code) {
            case "NOCONSOLE":
                return "O PS5 não está conectado ao servidor. Confira se o payload está rodando com relay= configurado.";
            case "BUSY":
                return "Este PS5 já tem o número máximo de aparelhos conectados.";
            case "TIMEOUT":
                return "O PS5 não respondeu ao pedido de conexão.";
            case "BADSID":
                return "O servidor recusou a conexão do PS5.";
            case "BADREQUEST":
                return "O servidor não entendeu o pedido.";
            default:
                return "Resposta inesperada do servidor: " + code;
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
        synchronized (out) {
            if (sessionKey != null) {
                writeSealed(line.getBytes(StandardCharsets.UTF_8));
            } else {
                writeText(line + "\n");
            }
        }
    }

    public long bytesReceived() {
        return bytesReceived;
    }

    private void writeText(String s) throws IOException {
        out.write(s.getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    private void writeSealed(byte[] plain) throws IOException {
        out.write(Secure.seal(sessionKey, Secure.DIR_CLIENT, txSeq, plain));
        out.flush();
        txSeq++;
    }

    private byte[] readSealed() throws IOException {
        int len = in.readInt();
        if (len < Secure.TAG_LEN || len > Secure.MAX_PLAIN + Secure.TAG_LEN) {
            throw new IOException("quadro com tamanho invalido");
        }
        byte[] body = new byte[len];
        in.readFully(body);
        byte[] plain = Secure.open(sessionKey, Secure.DIR_SERVER, rxSeq, body);
        rxSeq++;
        return plain;
    }

    /** One line of plain text (relay handshake only). */
    private String readLine() throws IOException {
        StringBuilder sb = new StringBuilder();
        for (;;) {
            int b = in.read();
            if (b < 0) throw new EOFException("conexao fechada");
            if (b == '\n') break;
            if (b != '\r' && sb.length() < 256) sb.append((char) b);
        }
        return sb.toString();
    }

    /** Reads packets until the connection ends; always throws at the end. */
    public void run(Listener l) throws IOException {
        try {
            while (!closed) {
                int type, flags;
                long pts;
                byte[] payload;
                if (sessionKey != null) {
                    byte[] plain = readSealed();
                    if (plain.length < 16) throw new IOException("pacote invalido");
                    type = plain[0] & 0xff;
                    flags = plain[1] & 0xff;
                    long length = be32(plain, 4);
                    pts = be64(plain, 8);
                    if (length != plain.length - 16) throw new IOException("pacote invalido");
                    payload = new byte[plain.length - 16];
                    System.arraycopy(plain, 16, payload, 0, payload.length);
                } else {
                    type = in.readUnsignedByte();
                    flags = in.readUnsignedByte();
                    in.readUnsignedShort();
                    long length = in.readInt() & 0xffffffffL;
                    pts = in.readLong();
                    if (length > MAX_PACKET) throw new IOException("pacote invalido (" + length + " bytes)");
                    payload = new byte[(int) length];
                    in.readFully(payload);
                }
                bytesReceived += 16 + payload.length;
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
                    case PKT_PAD:
                        l.onPad(payload.length > 0 ? payload[0] & 0xff : PAD_UNAVAILABLE);
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

    private static long be32(byte[] b, int off) {
        return ((b[off] & 0xffL) << 24) | ((b[off + 1] & 0xffL) << 16) | ((b[off + 2] & 0xffL) << 8) | (b[off + 3] & 0xffL);
    }

    private static long be64(byte[] b, int off) {
        long v = 0;
        for (int i = 0; i < 8; i++) v = (v << 8) | (b[off + i] & 0xffL);
        return v;
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
