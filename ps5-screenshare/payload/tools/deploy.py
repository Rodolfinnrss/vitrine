#!/usr/bin/env python3
"""Send an ELF payload to the PS5 ELF loader (ps5-payload-elfldr, port 9021).

usage: deploy.py <ps5-ip> [port] <file.elf>

Copyright (C) 2026 PS5 Screen Share contributors
SPDX-License-Identifier: GPL-3.0-or-later
"""
import socket
import sys


def main():
    args = sys.argv[1:]
    if len(args) == 2:
        host, path = args
        port = 9021
    elif len(args) == 3:
        host, port, path = args[0], int(args[1]), args[2]
    else:
        print(__doc__)
        sys.exit(2)
    data = open(path, "rb").read()
    with socket.create_connection((host, port), timeout=10) as s:
        s.sendall(data)
        s.shutdown(socket.SHUT_WR)
    print("sent %d bytes to %s:%d" % (len(data), host, port))


if __name__ == "__main__":
    main()
