/* PS5 Screen Share - LAN discovery (UDP broadcast "PS5SS?").
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later */
package com.ps5screenshare.client;

import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class Discovery {
    public static final class Console {
        public final String ip;
        public final int port;
        public final String firmware;
        public final int clients;

        Console(String ip, int port, String firmware, int clients) {
            this.ip = ip;
            this.port = port;
            this.firmware = firmware;
            this.clients = clients;
        }
    }

    private Discovery() {}

    private static Set<InetAddress> broadcastTargets() {
        Set<InetAddress> targets = new LinkedHashSet<>();
        try {
            for (NetworkInterface nif : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp() || nif.isLoopback()) continue;
                for (InterfaceAddress a : nif.getInterfaceAddresses()) {
                    if (a.getBroadcast() != null) targets.add(a.getBroadcast());
                }
            }
        } catch (Exception ignored) {
        }
        try {
            targets.add(InetAddress.getByName("255.255.255.255"));
        } catch (Exception ignored) {
        }
        return targets;
    }

    /** Blocking; returns the consoles that answered within timeoutMs. */
    public static List<Console> find(int port, int timeoutMs) {
        Map<String, Console> found = new LinkedHashMap<>();
        byte[] query = "PS5SS?".getBytes(StandardCharsets.US_ASCII);
        try (DatagramSocket s = new DatagramSocket()) {
            s.setBroadcast(true);
            s.setSoTimeout(200);
            long end = System.currentTimeMillis() + timeoutMs;
            int round = 0;
            while (System.currentTimeMillis() < end) {
                if (round++ < 3) {
                    for (InetAddress t : broadcastTargets()) {
                        try {
                            s.send(new DatagramPacket(query, query.length, t, port));
                        } catch (Exception ignored) {
                        }
                    }
                }
                byte[] buf = new byte[2048];
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                try {
                    s.receive(p);
                } catch (SocketTimeoutException e) {
                    continue;
                }
                String text = new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8);
                if (!text.startsWith("PS5SS! ")) continue;
                String ip = p.getAddress().getHostAddress();
                try {
                    JSONObject o = new JSONObject(text.substring(7));
                    found.put(ip, new Console(ip, o.optInt("port", port), o.optString("firmware", "?"),
                            o.optInt("clients", 0)));
                } catch (Exception e) {
                    found.put(ip, new Console(ip, port, "?", 0));
                }
            }
        } catch (Exception ignored) {
        }
        return new ArrayList<>(found.values());
    }
}
