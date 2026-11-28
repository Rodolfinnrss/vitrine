package com.ps5screenshare.client;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The app's relay mode against a relay and a console written from the spec in
 * relay/PROTOCOL.md (the console side is in this test, not in the app).
 */
public class StreamClientRelayTest {
    private static final byte[] SECRET = Secure.hexToBytes("a1b2c3d4e5f60718293a4b5c6d7e8f90");

    /** Reads one plain line from the socket. */
    private static String line(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        for (;;) {
            int b = in.read();
            if (b < 0) throw new IOException("eof");
            if (b == '\n') return sb.toString();
            sb.append((char) b);
        }
    }

    private static byte[] frame(DataInputStream in) throws IOException {
        int len = in.readInt();
        byte[] body = new byte[len];
        in.readFully(body);
        return body;
    }

    private static void write(OutputStream out, byte[] b) throws IOException {
        out.write(b);
        out.flush();
    }

    private static byte[] packet(int type, int flags, long pts, byte[] payload) {
        byte[] p = new byte[16 + payload.length];
        p[0] = (byte) type;
        p[1] = (byte) flags;
        int len = payload.length;
        p[4] = (byte) (len >>> 24);
        p[5] = (byte) (len >>> 16);
        p[6] = (byte) (len >>> 8);
        p[7] = (byte) len;
        for (int i = 0; i < 8; i++) p[8 + i] = (byte) (pts >>> (56 - 8 * i));
        System.arraycopy(payload, 0, p, 16, payload.length);
        return p;
    }

    /** Fake relay that pairs the client with a fake console on the same socket pair. */
    private static final class Fakes implements AutoCloseable {
        final ServerSocket server;
        final AtomicReference<String> seenCommand = new AtomicReference<>();
        final AtomicReference<String> helloSeen = new AtomicReference<>();
        final Thread thread;

        Fakes(byte[] consoleSecret, boolean sendStream) throws IOException {
            server = new ServerSocket(0, 4, java.net.InetAddress.getByName("127.0.0.1"));
            thread = new Thread(() -> serve(consoleSecret, sendStream));
            thread.setDaemon(true);
            thread.start();
        }

        private void serve(byte[] consoleSecret, boolean sendStream) {
            try (Socket client = server.accept()) {
                client.setSoTimeout(5000);
                InputStream in = client.getInputStream();
                OutputStream out = client.getOutputStream();
                String sub = line(in);
                // The fake relay routes any id: the cipher is what must refuse a wrong code.
                if (!sub.startsWith("SUB ")) return;
                write(out, "OK\n".getBytes(StandardCharsets.US_ASCII));
                // The console opens its tunnel and sends its salt in the clear.
                byte[] salt = new byte[16];
                new SecureRandom().nextBytes(salt);
                write(out, ("SALT " + Secure.bytesToHex(salt) + "\n").getBytes(StandardCharsets.US_ASCII));
                byte[] key = Secure.sessionKey(Secure.pairingKey(consoleSecret), salt);
                DataInputStream din = new DataInputStream(in);
                byte[] hello = Secure.open(key, Secure.DIR_CLIENT, 0, frame(din));
                helloSeen.set(new String(hello, StandardCharsets.UTF_8));
                if (!sendStream) return; // wrong code: the console cannot open the HELLO and closes
                byte[] header = {'P', 'S', '5', 'S', 0, 1, 0, 0};
                write(out, Secure.seal(key, Secure.DIR_SERVER, 0, header));
                write(out, Secure.seal(key, Secure.DIR_SERVER, 1,
                        packet(StreamClient.PKT_INFO, 0, 0, "{\"width\":1280}".getBytes(StandardCharsets.UTF_8))));
                write(out, Secure.seal(key, Secure.DIR_SERVER, 2,
                        packet(StreamClient.PKT_VIDEO, StreamClient.FLAG_KEYFRAME, 9000, new byte[] {0, 0, 0, 1, 0x65})));
                long rx = 1;
                for (int i = 0; i < 2; i++) {
                    byte[] cmd = Secure.open(key, Secure.DIR_CLIENT, rx++, frame(din));
                    seenCommand.set(new String(cmd, StandardCharsets.UTF_8));
                }
                Thread.sleep(200);
            } catch (Exception ignored) {
                // the test reads what it needs from the atomic fields
            }
        }

        @Override
        public void close() throws IOException {
            server.close();
        }
    }

    @Test
    public void appReachesTheConsoleThroughTheRelayAndGetsTheStream() throws Exception {
        try (Fakes fakes = new Fakes(SECRET, true)) {
            StreamClient c = StreamClient.viaRelay("127.0.0.1", fakes.server.getLocalPort(), SECRET,
                    "HELLO 1 audio=0 res=720p fps=60", 3000);
            List<String> got = new ArrayList<>();
            Thread reader = new Thread(() -> {
                try {
                    c.run(new StreamClient.Listener() {
                        @Override public void onInfo(String json) { got.add("info:" + json); }
                        @Override public void onVideo(byte[] d, long pts, boolean key) { got.add("video:" + pts + ":" + key); }
                        @Override public void onAudio(byte[] d, long pts) {}
                        @Override public void onStatus(String t) {}
                        @Override public void onPong(String t) {}
                        @Override public void onPad(int s) {}
                    });
                } catch (IOException ignored) {
                    // the console closes at the end
                }
            });
            reader.start();
            for (int i = 0; i < 100 && got.size() < 2; i++) Thread.sleep(20);
            c.send("PAD 1,16384,128,128,128,128,0,0");
            c.send("KEY");
            for (int i = 0; i < 100 && fakes.seenCommand.get() == null; i++) Thread.sleep(20);
            c.close();
            reader.join(2000);
            assertEquals("HELLO 1 audio=0 res=720p fps=60", fakes.helloSeen.get());
            assertTrue(got.toString(), got.contains("info:{\"width\":1280}"));
            assertTrue(got.toString(), got.contains("video:9000:true"));
            assertEquals("KEY", fakes.seenCommand.get());
        }
    }

    @Test
    public void wrongPairingCodeIsRefusedBeforeAnyStream() throws Exception {
        byte[] wrong = Secure.hexToBytes("ffffffffffffffffffffffffffffffff");
        try (Fakes fakes = new Fakes(SECRET, false)) {
            try {
                StreamClient.viaRelay("127.0.0.1", fakes.server.getLocalPort(), wrong, "HELLO 1", 3000).close();
                fail("a stream opened with the wrong pairing code");
            } catch (IOException expected) {
                // The console cannot open the HELLO, so it sends nothing and the app stops here.
            }
        }
    }
}
