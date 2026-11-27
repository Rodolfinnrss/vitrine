#!/usr/bin/env python3
"""Supervisor test with a fake ELF loader: the loader saves each ELF it
receives and runs it (the host build embeds the host service binary).

usage: supervisor_test.py build/host/ps5ss-supervisor [test.h264]

Copyright (C) 2026 PS5 Screen Share contributors
SPDX-License-Identifier: GPL-3.0-or-later
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ps5ss_client as ps  # noqa: E402

SUP = os.path.abspath(sys.argv[1])
H264 = sys.argv[2] if len(sys.argv) > 2 else None
WORK = tempfile.mkdtemp(prefix="ps5ss-sup-")
FAILS = []
launched = []


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        FAILS.append(msg)


def fake_loader(env):
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 19021))
    srv.listen(4)
    while True:
        conn, _ = srv.accept()
        data = b""
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                break
            data += chunk
        conn.close()
        path = os.path.join(WORK, "payload-%d" % len(launched))
        with open(path, "wb") as f:
            f.write(data)
        os.chmod(path, 0o755)
        log = open(path + ".log", "w")
        launched.append(subprocess.Popen([path], env=env, stdout=log, stderr=subprocess.STDOUT))


def main():
    if not H264:
        h = os.path.join(WORK, "t.h264")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=60",
                        "-t", "4", "-c:v", "libx264", "-g", "60", "-bf", "0", "-x264-params", "aud=1", h],
                       check=True)
    else:
        h = H264
    env = dict(os.environ, PS5SS_MOCK_H264=h, PS5SS_MOCK_LOSE_AFTER="60", PS5SS_MOCK_STUCK="1",
               ASAN_OPTIONS="detect_leaks=0")
    threading.Thread(target=fake_loader, args=(env,), daemon=True).start()
    time.sleep(0.2)
    sup = subprocess.Popen([SUP], env=env, stdout=open(os.path.join(WORK, "sup.log"), "w"),
                           stderr=subprocess.STDOUT)
    try:
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", 9700), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.1)
        check(len(launched) == 1, "supervisor sent the service ELF to the loader")
        c = ps.Client("127.0.0.1", 9700, "HELLO 1 audio=0 res=720p fps=30 bitrate=4000")
        # Stuck after 60 frames -> two failed opens -> restart request -> new process.
        deadline = time.time() + 25
        while time.time() < deadline and len(launched) < 2:
            try:
                c.packet()
            except (EOFError, OSError):
                break
        for _ in range(100):
            if len(launched) >= 2:
                break
            time.sleep(0.2)
        check(len(launched) >= 2, "a fresh service was launched after the stuck capture")
        time.sleep(1.5)
        st = None
        for _ in range(50):
            try:
                with urllib.request.urlopen("http://127.0.0.1:9700/status", timeout=2) as r:
                    st = json.loads(r.read())
                if st["generation"] >= 2:
                    break
            except OSError:
                pass
            time.sleep(0.2)
        check(st and st["generation"] == 2, "second generation is serving")
        check(st and st["requested"]["fps"] == 30 and st["requested"]["kbps"] == 4000,
              "settings survive the restart")
        # Sending the supervisor again replaces the running copy.
        sup2 = subprocess.Popen([SUP], env=env, stdout=open(os.path.join(WORK, "sup2.log"), "w"),
                                stderr=subprocess.STDOUT)
        try:
            sup.wait(15)
        except subprocess.TimeoutExpired:
            pass
        check(sup.poll() is not None, "old supervisor exits when replaced")
        for _ in range(100):
            if len(launched) >= 3:
                break
            time.sleep(0.1)
        check(len(launched) >= 3, "new supervisor launches its own service")
        # Killing the service without a restart request stops the supervisor.
        time.sleep(1.5)
        launched[-1].terminate()
        try:
            sup2.wait(10)
        except subprocess.TimeoutExpired:
            pass
        check(sup2.poll() == 0, "supervisor stops when its service exits")
    finally:
        for p in [sup] + launched:
            if p.poll() is None:
                p.kill()
        try:
            sup2.kill()
        except Exception:
            pass
    if FAILS:
        print("%d FAILED (logs in %s)" % (len(FAILS), WORK))
        sys.exit(1)
    print("supervisor tests passed")


if __name__ == "__main__":
    main()
