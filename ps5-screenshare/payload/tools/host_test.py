#!/usr/bin/env python3
"""Host integration tests: run the service with the mock capture backend and
exercise HTTP, discovery, streaming, resync, settings, recovery and QUIT.

usage: host_test.py build/host/ps5ss-service [test.h264]

Copyright (C) 2026 PS5 Screen Share contributors
SPDX-License-Identifier: GPL-3.0-or-later
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ps5ss_client as ps  # noqa: E402

BIN = os.path.abspath(sys.argv[1])
WORK = tempfile.mkdtemp(prefix="ps5ss-test-")
H264 = sys.argv[2] if len(sys.argv) > 2 else os.path.join(WORK, "test.h264")
PORT = 19700
FAILS = []


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        FAILS.append(msg)


def make_clip():
    if os.path.exists(H264):
        return
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                    "testsrc2=size=1280x720:rate=60", "-t", "6", "-c:v", "libx264",
                    "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p",
                    "-g", "60", "-bf", "0", "-x264-params", "aud=1", "-b:v", "6M", H264],
                   check=True)


class Service:
    def __init__(self, port=PORT, env=None, args=()):
        e = dict(os.environ, PS5SS_MOCK_H264=H264,
                 ASAN_OPTIONS="detect_leaks=0:abort_on_error=1")
        e.update(env or {})
        self.log = open(os.path.join(WORK, "service-%d.log" % port), "w")
        self.p = subprocess.Popen([BIN, "port=%d" % port, "notify=1"] + list(args),
                                  env=e, stdout=self.log, stderr=subprocess.STDOUT)
        self.port = port
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                return
            except OSError:
                time.sleep(0.05)
        raise RuntimeError("service did not start")

    def text(self):
        self.log.flush()
        with open(self.log.name) as f:
            return f.read()

    def stop(self):
        if self.p.poll() is None:
            self.p.terminate()
            try:
                self.p.wait(5)
            except subprocess.TimeoutExpired:
                self.p.kill()
        return self.p.returncode


def http(path, port=PORT):
    with urllib.request.urlopen("http://127.0.0.1:%d%s" % (port, path), timeout=5) as r:
        return r.status, r.headers, r.read()


def collect(client, seconds, out=None):
    stats = {"video": 0, "key": 0, "audio": 0, "info": [], "status": [], "first_video_key": None,
             "pts": []}
    end = time.time() + seconds
    while time.time() < end:
        t, flags, pts, data = client.packet()
        if t == ps.PKT_VIDEO:
            if stats["first_video_key"] is None:
                stats["first_video_key"] = bool(flags & 1)
            stats["video"] += 1
            stats["key"] += flags & 1
            stats["pts"].append(pts)
            if out:
                out.write(data)
        elif t == ps.PKT_AUDIO:
            stats["audio"] += 1
            stats["audio_len"] = len(data)
        elif t == ps.PKT_INFO:
            stats["info"].append(json.loads(data))
        elif t == ps.PKT_STATUS:
            stats["status"].append(data.decode())
    return stats


def decodes(path):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-v", "error", "-i", path, "-f", "null", "-"],
                       capture_output=True, text=True)
    n = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-show_entries",
                        "stream=nb_read_frames", "-of", "csv=p=0", path],
                       capture_output=True, text=True).stdout.strip()
    return r.returncode == 0 and not r.stderr.strip(), int(n or 0), r.stderr.strip()[:300]


def test_basic():
    print("basic streaming, HTTP and discovery")
    s = Service()
    try:
        st, hdr, body = http("/")
        check(st == 200 and b"PS5 Screen Share" in body, "GET / serves the status page")
        st, hdr, body = http("/status")
        j = json.loads(body)
        check(j["app"] == "ps5-screenshare" and j["port"] == PORT, "GET /status is JSON")
        st, hdr, body = http("/log")
        check(b"listening" in body, "GET /log returns the log")
        try:
            http("/app.apk")
            has_apk = True
        except urllib.error.HTTPError as e:
            has_apk = e.code != 404
        print("     (apk embedded: %s)" % has_apk)

        found = ps.discover(timeout=1.0, port=PORT, targets=("127.0.0.1",))
        check(any(v.get("port") == PORT for v in found.values()), "UDP discovery answers")

        c = ps.Client("127.0.0.1", PORT, "HELLO 1 audio=1 res=720p fps=60")
        path = os.path.join(WORK, "basic.h264")
        with open(path, "wb") as f:
            stats = collect(c, 4.0, f)
        c.send_line("PING 1234")
        pong = None
        for _ in range(400):
            t, _, _, d = c.packet()
            if t == ps.PKT_PONG:
                pong = d
                break
        c.close()
        check(pong == b"1234", "PING is answered with PONG")
        check(stats["info"] and stats["info"][0]["width"] == 1280, "INFO announces 1280x720")
        check(stats["first_video_key"] is True, "first video packet is an IDR")
        check(150 <= stats["video"] <= 260, "~60 fps delivered (%d frames in 4 s)" % stats["video"])
        check(120 <= stats["audio"] <= 220 and stats.get("audio_len") == 4096,
              "audio blocks of 1024 stereo s16 frames (%d)" % stats["audio"])
        check(all(b > a for a, b in zip(stats["pts"], stats["pts"][1:])), "video pts increase")
        ok, frames, err = decodes(path)
        check(ok and frames >= 150, "received H.264 decodes cleanly (%d frames) %s" % (frames, err))
    finally:
        s.stop()


def test_two_clients_and_resync():
    print("two clients, slow client resync, settings change")
    s = Service()
    try:
        fast = ps.Client("127.0.0.1", PORT, "HELLO 1 audio=0")
        slow = ps.Client("127.0.0.1", PORT, "HELLO 1 audio=1", rcvbuf=65536)
        fstats = collect(fast, 5.0)     # slow client reads nothing meanwhile
        check(fstats["audio"] == 0, "audio=0 client receives no audio")
        check(fstats["video"] >= 200, "fast client unaffected by the stalled one (%d)" % fstats["video"])
        st = json.loads(http("/status")[2])
        resyncs = sum(c["resyncs"] for c in st["clients"])
        check(len(st["clients"]) == 2, "status lists both clients")
        check(resyncs >= 1, "stalled client was resynchronised (%d)" % resyncs)
        path = os.path.join(WORK, "slow.h264")
        with open(path, "wb") as f:
            sstats = collect(slow, 2.0, f)
        ok, frames, err = decodes(path)
        check(sstats["first_video_key"] is True, "after a drop the client restarts at an IDR")
        check(ok and frames >= 60, "stalled client's stream decodes after resync (%d of %d) %s"
              % (frames, sstats["video"], err))
        slow.close()

        fast.send_line("SET res=1080p bitrate=9000")
        stats = collect(fast, 2.0)
        infos = [i for i in stats["info"] if i["height"] == 1080]
        check(infos and infos[0]["kbps"] == 9000, "SET reopens capture and announces 1080p/9000")
        fast.close()
        time.sleep(0.3)
        check(json.loads(http("/status")[2])["clients"] == [], "clients removed after disconnect")
    finally:
        s.stop()


def test_limits_and_bad_input():
    print("client limit and invalid input")
    s = Service()
    try:
        clients = [ps.Client("127.0.0.1", PORT, "HELLO 1 audio=0") for _ in range(4)]
        extra = ps.Client("127.0.0.1", PORT, "HELLO 1")
        t, _, _, d = extra.packet()
        check(t == ps.PKT_STATUS and b"cheio" in d, "fifth client is told the server is full")
        extra.close()
        for c in clients:
            c.close()
        junk = socket.create_connection(("127.0.0.1", PORT))
        junk.sendall(b"\x00\x01garbage\n")
        time.sleep(0.2)
        junk.close()
        bad = ps.Client("127.0.0.1", PORT, "HELLO 1 res=999p fps=13")
        st = collect(bad, 1.0)
        check(any("invalida" in x for x in st["status"]), "invalid settings are reported")
        bad.close()
        check(s.p.poll() is None, "service survives junk and bad settings")
    finally:
        s.stop()


def test_recovery_and_variant_rotation():
    print("open failures, variant rotation and session loss")
    s = Service(env={"PS5SS_MOCK_FAIL_OPEN": "1", "PS5SS_MOCK_LOSE_AFTER": "90"},
                args=("idle_timeout=1",))
    try:
        c = ps.Client("127.0.0.1", PORT, "HELLO 1 audio=0")
        stats = collect(c, 7.0)
        c.close()
        log = s.text()
        check("trying OpenVideo record variant" in log, "invalid request rotates the record variant")
        check("0x81950009" in log, "session loss is logged")
        check(len(stats["info"]) >= 2 and stats["video"] > 150,
              "streaming resumes after the loss (%d frames, %d sessions)"
              % (stats["video"], len(stats["info"])))
        time.sleep(2.5)
        check("no viewers; capture closed" in s.text(), "capture closes when the last viewer leaves")
    finally:
        s.stop()


def test_supervised_restart_and_quit():
    print("supervisor link: restart request and QUIT")
    ctl = socket.socket()
    ctl.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    ctl.bind(("127.0.0.1", PORT + 1000))
    ctl.listen(1)
    ctl.settimeout(5)
    accepted = []

    def supervisor():
        conn, _ = ctl.accept()
        conn.sendall(b"G3 W1280 H720 F30 B4000 A1\n")
        accepted.append(conn)

    import threading
    th = threading.Thread(target=supervisor)
    th.start()
    s = Service(env={"PS5SS_MOCK_LOSE_AFTER": "60", "PS5SS_MOCK_STUCK": "1"})
    try:
        th.join(5)
        conn = accepted[0]
        time.sleep(0.3)
        st = json.loads(http("/status")[2])
        check(st["requested"]["resolution"] == "720p" and st["requested"]["fps"] == 30
              and st["requested"]["kbps"] == 4000, "settings handed over by the supervisor apply")
        check(st["generation"] == 3, "generation reported")
        c = ps.Client("127.0.0.1", PORT, "HELLO 1 audio=0")
        conn.settimeout(15)
        line = b""
        try:
            while not line.endswith(b"\n"):
                chunk = conn.recv(64)
                if not chunk:
                    break
                line += chunk
        except socket.timeout:
            pass
        check(line.startswith(b"R W1280 H720 F30 B4000 A1"), "stuck capture asks for a fresh process: %r" % line)
        try:
            s.p.wait(10)
        except subprocess.TimeoutExpired:
            pass
        check(s.p.poll() is not None, "service exits after the restart request")
        c.sock.close()
        conn.close()
    finally:
        s.stop()
        ctl.close()

    s = Service()
    try:
        r = socket.create_connection(("127.0.0.1", PORT))
        r.sendall(b"QUIT\n")
        check(r.recv(8) == b"BYE\n", "QUIT from loopback is acknowledged")
        r.close()
        try:
            s.p.wait(5)
        except subprocess.TimeoutExpired:
            pass
        check(s.p.poll() == 0, "service exits cleanly after QUIT (rc=%s)" % s.p.poll())
        s2 = Service()   # a second copy replaces a running one
        s3 = Service.__new__(Service)
        check(s2.p.poll() is None, "a new copy starts on the freed port")
        s2.stop()
        del s3
    finally:
        s.stop()


def wait_pad(client, limit=3000):
    """Reads packets until the next PKT_PAD and returns its availability byte."""
    for _ in range(limit):
        t, _, _, d = client.packet()
        if t == ps.PKT_PAD:
            return d[0]
    return None


def pad_status():
    return json.loads(http("/status")[2])["pad"]


class KeepAlive:
    """Sends a PAD line every 50 ms, as the Android app does while it holds the
    controller (the console neutralises the pad after 250 ms of silence)."""

    def __init__(self, client, template):
        self.client, self.template, self.seq = client, template, 100
        self.running = True
        self.thread = threading.Thread(target=self.loop, daemon=True)
        self.thread.start()

    def loop(self):
        while self.running:
            self.seq += 1
            try:
                self.client.send_line(self.template % self.seq)
            except OSError:
                return
            time.sleep(0.05)

    def stop(self):
        self.running = False
        self.thread.join(2)


def test_pad_control():
    print("virtual controller: ownership, input, release, malformed input")
    s = Service()
    try:
        a = ps.Client("127.0.0.1", PORT, "HELLO 1 audio=0")
        check(wait_pad(a) == 1, "a free controller is announced to a viewer")
        a.send_line("PAD 1,16384,128,128,128,128,0,0")
        check(wait_pad(a) == 2, "first viewer takes control (PAD_YOURS)")
        keep_a = KeepAlive(a, "PAD %d,16384,128,128,128,128,0,0")
        time.sleep(0.3)
        st = pad_status()
        check(st["available"] and st["owned"], "status: pad owned")
        check(st["buttons"] == "0x4000" and st["writes"] > 0, "cross reached the backend (%s)" % st)

        b = ps.Client("127.0.0.1", PORT, "HELLO 1 audio=0")
        check(wait_pad(b) == 3, "second viewer sees the controller busy")
        b.send_line("PAD 1,8192,128,128,128,128,0,0")
        time.sleep(0.2)
        check(pad_status()["buttons"] == "0x4000", "busy viewer's input is not applied")

        keep_a.stop()
        a.close()
        time.sleep(0.3)
        st = pad_status()
        check(not st["owned"] and st["buttons"] == "0x0", "owner disconnect releases and neutralises (%s)" % st)

        keep_b = KeepAlive(b, "PAD %d,8192,128,128,128,128,0,0")
        check(wait_pad(b) == 2, "the other viewer takes over after the release")
        time.sleep(0.2)
        check(pad_status()["buttons"] == "0x2000", "circle reached the backend")

        keep_b.stop()
        # Malformed lines must be ignored while the owner keeps going.
        b.send_line("PAD 3,0x10,0,0,0,0,0,0")
        b.send_line("PAD 4,4294967295,0,0,0,0,0,0")
        b.send_line("PAD 5,8192,300,0,0,0,0,0")
        keep_b = KeepAlive(b, "PAD %d,8192,128,128,128,128,0,0")
        time.sleep(0.3)
        keep_b.stop()
        check(pad_status()["buttons"] == "0x2000", "malformed PAD lines are ignored")
        b.send_line("PADSTATE")
        check(wait_pad(b) == 2, "PADSTATE is always answered; connection still works")

        b.send_line("PADRELEASE")
        check(wait_pad(b) == 1, "PADRELEASE is answered with 'free'")
        check(not pad_status()["owned"], "PADRELEASE gives the controller up")

        b.send_line("PAD 6,8192,128,128,128,128,0,0")
        check(wait_pad(b) == 2, "viewer re-takes control")
        time.sleep(2.5)
        check(not pad_status()["owned"], "silent owner is released after 2 s")
        b.close()
    finally:
        s.stop()

    s = Service(env={"PS5SS_MOCK_PAD": "0"})
    try:
        c = ps.Client("127.0.0.1", PORT, "HELLO 1 audio=0")
        check(wait_pad(c) == 0, "no virtual controller: viewers are told it is unavailable")
        c.send_line("PAD 1,16384,128,128,128,128,0,0")
        time.sleep(0.2)
        st = pad_status()
        check(not st["available"] and st["writes"] == 0, "unavailable pad takes no input")
        c.close()
    finally:
        s.stop()

    s = Service(args=("pad=0",))
    try:
        c = ps.Client("127.0.0.1", PORT, "HELLO 1 audio=0")
        check(wait_pad(c) == 0, "pad=0 in config.ini-style arguments disables the controller")
        c.close()
    finally:
        s.stop()


RELAY_PORT = 19950


def test_relay_sealed():
    print("relay: console dials out, sealed viewer sessions, wrong code refused")
    relay_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "relay"))
    relay_log = open(os.path.join(WORK, "relay.log"), "w")
    relay = subprocess.Popen(["node", os.path.join(relay_dir, "server.js"), str(RELAY_PORT)],
                             stdout=relay_log, stderr=subprocess.STDOUT)
    s = None
    try:
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", RELAY_PORT), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.05)
        s = Service(args=("relay=127.0.0.1:%d" % RELAY_PORT,))
        code_file = os.path.join(os.path.dirname(BIN), "data", "pairing.txt")
        check(os.path.exists(code_file), "the console creates its pairing code")
        code = open(code_file).read().strip()
        check(len(code.replace("-", "")) == 32, "pairing code has 128 bits (%s)" % code)
        secret = ps.pairing_secret(code)
        my_id = ps.pairing_id(secret)

        connected = False
        for _ in range(100):
            st = json.loads(http("/status")[2])
            if st["relay"]["connected"] == 1:
                connected = True
                break
            time.sleep(0.1)
        check(connected, "console registers with the relay")
        check(st["relay"]["pairing_id"] == my_id, "console reports the same pairing id as the derivation")
        check(st["relay"]["configured"] == 1 and st["relay"]["port"] == RELAY_PORT, "relay settings in /status")
        check(code not in json.dumps(st), "the pairing secret itself never appears in /status")

        v = ps.RelayClient("127.0.0.1", RELAY_PORT, code, "HELLO 1 audio=0 res=720p fps=60")
        check(getattr(v, "version", 0) == 1, "sealed stream header decrypts (proves the console knows the code)")
        stats = collect_relay(v, 3.0)
        check(stats["info"] and stats["info"][0]["width"] == 1280, "INFO arrives through the relay")
        check(stats["video"] >= 90, "video arrives through the relay (%d frames in 3 s)" % stats["video"])
        check(stats["first_video_key"] is True, "first video packet through the relay is an IDR")
        v.send_line("PAD 1,16384,128,128,128,128,0,0")
        time.sleep(0.3)
        check(json.loads(http("/status")[2])["pad"]["owned"] == 1, "a command sent through the tunnel reaches the console")
        v.send_line("PADRELEASE")
        v.close()

        # Right console id, wrong key: the relay routes it, the console cannot open the
        # client's HELLO and closes without sending anything. The client sees only the end.
        try:
            ps.RelayClient("127.0.0.1", RELAY_PORT, "00" * 16, console_id=my_id)
            check(False, "a wrong pairing code must not open a session")
        except EOFError:
            check(True, "a wrong pairing code gets no stream: the console closes first")
        except Exception as err:
            check(False, "unexpected error for a wrong pairing code: %s" % type(err).__name__)

        try:
            ps.RelayClient("127.0.0.1", RELAY_PORT, code, console_id="0" * 16)
            check(False, "an unknown console id must not connect")
        except IOError as err:
            check("NOCONSOLE" in str(err), "an unknown console id is answered NOCONSOLE")
    finally:
        if s is not None:
            s.stop()
        relay.terminate()
        try:
            relay.wait(5)
        except subprocess.TimeoutExpired:
            relay.kill()
        relay_log.close()


def collect_relay(client, seconds):
    stats = {"video": 0, "audio": 0, "info": [], "first_video_key": None}
    end = time.time() + seconds
    while time.time() < end:
        t, flags, pts, data = client.packet()
        if t == ps.PKT_VIDEO:
            if stats["first_video_key"] is None:
                stats["first_video_key"] = bool(flags & 1)
            stats["video"] += 1
        elif t == ps.PKT_AUDIO:
            stats["audio"] += 1
        elif t == ps.PKT_INFO:
            stats["info"].append(json.loads(data))
    return stats


def main():
    make_clip()
    try:
        test_basic()
        test_two_clients_and_resync()
        test_limits_and_bad_input()
        test_recovery_and_variant_rotation()
        test_supervised_restart_and_quit()
        test_pad_control()
        test_relay_sealed()
    finally:
        if not FAILS:
            shutil.rmtree(WORK, ignore_errors=True)
    print()
    if FAILS:
        print("%d FAILED (logs in %s):" % (len(FAILS), WORK))
        for f in FAILS:
            print("  -", f)
        sys.exit(1)
    print("all host tests passed")


if __name__ == "__main__":
    main()
