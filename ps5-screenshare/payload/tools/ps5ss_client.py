#!/usr/bin/env python3
"""Minimal PS5 Screen Share client (protocol reference and PC viewer).

    python3 ps5ss_client.py 192.168.0.10 | ffplay -fflags nobuffer -f h264 -
    python3 ps5ss_client.py 192.168.0.10 --video out.h264 --audio out.pcm --seconds 30
    python3 ps5ss_client.py --discover

Copyright (C) 2026 PS5 Screen Share contributors
SPDX-License-Identifier: GPL-3.0-or-later
"""
import argparse
import json
import socket
import struct
import sys
import time

PORT = 9700
PKT_KEEPALIVE, PKT_INFO, PKT_VIDEO, PKT_AUDIO, PKT_STATUS, PKT_PONG, PKT_PAD = range(7)
NAMES = {0: "KEEPALIVE", 1: "INFO", 2: "VIDEO", 3: "AUDIO", 4: "STATUS", 5: "PONG", 6: "PAD"}


def discover(timeout=1.5, port=PORT, targets=("255.255.255.255",)):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.settimeout(0.2)
    for t in targets:
        try:
            s.sendto(b"PS5SS?", (t, port))
        except OSError:
            pass
    found = {}
    end = time.time() + timeout
    while time.time() < end:
        try:
            data, addr = s.recvfrom(2048)
        except socket.timeout:
            continue
        if data.startswith(b"PS5SS! "):
            info = json.loads(data[7:].decode())
            found[addr[0]] = info
    s.close()
    return found


class Client:
    def __init__(self, host, port=PORT, hello="HELLO 1 audio=1", timeout=10, rcvbuf=0):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        if rcvbuf:
            self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, rcvbuf)
        self.sock.settimeout(timeout)
        self.sock.connect((host, port))
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.send_line(hello)
        magic = self._read(8)
        if magic[:4] != b"PS5S":
            raise IOError("bad stream header %r" % magic)
        self.version = struct.unpack(">H", magic[4:6])[0]

    def send_line(self, line):
        self.sock.sendall(line.encode() + b"\n")

    def _read(self, n):
        buf = bytearray()
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise EOFError("connection closed")
            buf += chunk
        return bytes(buf)

    def packet(self):
        """Returns (type, flags, pts_us, payload)."""
        h = self._read(16)
        ptype, flags, _, length, pts = struct.unpack(">BBHIQ", h)
        if length > 64 * 1024 * 1024:
            raise IOError("packet too large")
        return ptype, flags, pts, self._read(length)

    def close(self):
        try:
            self.send_line("BYE")
        except OSError:
            pass
        self.sock.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("host", nargs="?")
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--discover", action="store_true")
    ap.add_argument("--res", help="720p, 1080p, 1440p or 2160p")
    ap.add_argument("--fps", type=int)
    ap.add_argument("--bitrate", type=int, help="kbit/s")
    ap.add_argument("--video", help="write H.264 Annex-B here (default: stdout)")
    ap.add_argument("--audio", help="write raw s16le stereo 48 kHz PCM here")
    ap.add_argument("--seconds", type=float, default=0)
    args = ap.parse_args()
    if args.discover or not args.host:
        for ip, info in discover(port=args.port).items():
            print(ip, json.dumps(info))
        return
    hello = "HELLO 1 audio=%d" % (1 if args.audio else 0)
    if args.res:
        hello += " res=" + args.res
    if args.fps:
        hello += " fps=%d" % args.fps
    if args.bitrate:
        hello += " bitrate=%d" % args.bitrate
    c = Client(args.host, args.port, hello)
    vout = open(args.video, "wb") if args.video else sys.stdout.buffer
    aout = open(args.audio, "wb") if args.audio else None
    start = time.time()
    try:
        while not args.seconds or time.time() - start < args.seconds:
            t, flags, pts, data = c.packet()
            if t == PKT_VIDEO:
                vout.write(data)
                vout.flush()
            elif t == PKT_AUDIO and aout:
                aout.write(data)
            elif t in (PKT_INFO, PKT_STATUS):
                print("%s: %s" % (NAMES[t], data.decode(errors="replace")), file=sys.stderr)
    except (EOFError, BrokenPipeError, KeyboardInterrupt):
        pass
    finally:
        c.close()


if __name__ == "__main__":
    main()
