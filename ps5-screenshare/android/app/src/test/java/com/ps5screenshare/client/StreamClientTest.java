package com.ps5screenshare.client;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeFalse;

import org.junit.Test;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

public class StreamClientTest {
    static final class Recorder implements StreamClient.Listener {
        final List<String> events = new ArrayList<>();
        int video, keyframes, audio;
        long lastPts = -1;
        boolean ptsIncreasing = true;

        @Override public void onInfo(String json) { events.add("info:" + json); }
        @Override public void onVideo(byte[] d, long pts, boolean key) {
            video++;
            if (key) keyframes++;
            if (pts <= lastPts) ptsIncreasing = false;
            lastPts = pts;
        }
        @Override public void onAudio(byte[] d, long pts) { audio++; events.add("audio:" + d.length); }
        @Override public void onStatus(String t) { events.add("status:" + t); }
        @Override public void onPong(String t) { events.add("pong:" + t); }
    }

    private static void packet(DataOutputStream o, int type, int flags, long pts, byte[] p) throws IOException {
        o.writeByte(type);
        o.writeByte(flags);
        o.writeShort(0);
        o.writeInt(p.length);
        o.writeLong(pts);
        o.write(p);
    }

    @Test
    public void parsesEveryPacketTypeFromFakeServer() throws Exception {
        AtomicReference<String> hello = new AtomicReference<>();
        try (ServerSocket ss = new ServerSocket(0)) {
            Thread server = new Thread(() -> {
                try (Socket s = ss.accept()) {
                    BufferedReader r = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
                    hello.set(r.readLine());
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    DataOutputStream o = new DataOutputStream(bytes);
                    o.write(new byte[] {'P', 'S', '5', 'S', 0, 1, 0, 0});
                    packet(o, StreamClient.PKT_INFO, 0, 0, "{\"width\":1920}".getBytes(StandardCharsets.UTF_8));
                    packet(o, StreamClient.PKT_KEEPALIVE, 0, 0, new byte[0]);
                    packet(o, StreamClient.PKT_VIDEO, 1, 1000, new byte[] {0, 0, 0, 1, 0x65});
                    packet(o, StreamClient.PKT_VIDEO, 0, 17683, new byte[] {0, 0, 0, 1, 0x41});
                    packet(o, StreamClient.PKT_AUDIO, 0, 5000, new byte[4096]);
                    packet(o, StreamClient.PKT_STATUS, 0, 0, "Transmitindo".getBytes(StandardCharsets.UTF_8));
                    packet(o, 99, 0, 0, new byte[3]); // unknown types are skipped
                    packet(o, StreamClient.PKT_PONG, 0, 0, "42".getBytes(StandardCharsets.UTF_8));
                    s.getOutputStream().write(bytes.toByteArray());
                    s.getOutputStream().flush();
                } catch (IOException ignored) {
                }
            });
            server.start();
            Recorder rec = new Recorder();
            StreamClient c = new StreamClient("127.0.0.1", ss.getLocalPort(),
                    StreamClient.hello(false, "1080p", 60, 8000), 2000);
            try {
                c.run(rec);
            } catch (IOException expected) {
                // the fake server closes the connection at the end
            }
            c.close();
            server.join(2000);
            assertEquals("HELLO 1 audio=0 res=1080p fps=60 bitrate=8000", hello.get());
            assertEquals(2, rec.video);
            assertEquals(1, rec.keyframes);
            assertEquals(1, rec.audio);
            assertTrue(rec.events.contains("info:{\"width\":1920}"));
            assertTrue(rec.events.contains("status:Transmitindo"));
            assertTrue(rec.events.contains("pong:42"));
        }
    }

    @Test(expected = IOException.class)
    public void rejectsOtherServers() throws Exception {
        try (ServerSocket ss = new ServerSocket(0)) {
            new Thread(() -> {
                try (Socket s = ss.accept()) {
                    s.getOutputStream().write("HTTP/1.1 400 Bad\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                } catch (IOException ignored) {
                }
            }).start();
            new StreamClient("127.0.0.1", ss.getLocalPort(), "HELLO 1", 2000).close();
        }
    }

    /** Runs against a real payload (host build or console) when PS5SS_TEST_HOST is set. */
    @Test
    public void streamsFromLiveServer() throws Exception {
        String host = System.getProperty("ps5ss.host", "");
        assumeFalse("set PS5SS_TEST_HOST to run", host.isEmpty());
        int port = Integer.parseInt(System.getProperty("ps5ss.port", "9700"));
        Recorder rec = new Recorder();
        StreamClient c = new StreamClient(host, port, StreamClient.hello(true, "720p", 60, 0), 3000);
        Thread killer = new Thread(() -> {
            try {
                Thread.sleep(1000);
                c.send("PING 7");
                Thread.sleep(2000);
            } catch (Exception ignored) {
            }
            c.close();
        });
        killer.start();
        try {
            c.run(rec);
        } catch (IOException expected) {
        }
        killer.join();
        System.out.println("live: video=" + rec.video + " key=" + rec.keyframes + " audio=" + rec.audio);
        assertTrue("video frames", rec.video > 100);
        assertTrue("starts with keyframe", rec.keyframes >= 1);
        assertTrue("audio", rec.audio > 50);
        assertTrue("pts increase", rec.ptsIncreasing);
        assertTrue(rec.events.contains("pong:7"));
        boolean info720 = false;
        for (String e : rec.events) info720 |= e.startsWith("info:") && e.contains("\"height\":720");
        assertTrue("info for 720p", info720);
    }
}
