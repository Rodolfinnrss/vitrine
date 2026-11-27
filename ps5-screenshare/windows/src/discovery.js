/* PS5 Screen Share - finds consoles on the local network (UDP broadcast).
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Broadcast does not cross routers, so over a VPN type the console address instead.
 */
'use strict';

const dgram = require('node:dgram');
const os = require('node:os');
const Protocol = require('./protocol');

/** Broadcast address of every active IPv4 interface, plus the limited broadcast. */
function broadcastAddresses(ifaces) {
  const list = new Set(['255.255.255.255']);
  const nets = ifaces || os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const a of nets[name] || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      list.add(ip.map((octet, i) => (octet | (~mask[i] & 255))).join('.'));
    }
  }
  return [...list];
}

/**
 * Asks the network for consoles. Resolves with the list of replies received
 * within timeoutMs, de-duplicated by address.
 */
function discover(options) {
  const o = options || {};
  const port = o.port || Protocol.DEFAULT_PORT;
  const timeoutMs = o.timeoutMs || 1500;
  const targets = o.targets || broadcastAddresses();
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let timer = null;
    let repeat = null;
    const done = () => {
      clearTimeout(timer);
      clearInterval(repeat);
      try {
        sock.close();
      } catch (e) {
        // already closed
      }
      resolve([...found.values()]);
    };
    sock.on('error', done);
    sock.on('message', (msg, rinfo) => {
      const reply = Protocol.parseDiscoveryReply(msg.toString('utf8'));
      if (!reply) return;
      const ip = reply.ip || rinfo.address;
      found.set(ip, Object.assign(reply, { ip }));
    });
    sock.bind(0, () => {
      sock.setBroadcast(true);
      const query = Buffer.from(Protocol.DISCOVERY_QUERY, 'ascii');
      const send = () => {
        for (const t of targets) {
          sock.send(query, port, t, () => {});
        }
      };
      send();
      let rounds = 1;
      repeat = setInterval(() => {
        if (rounds++ < 3) send();
      }, 400);
      timer = setTimeout(done, timeoutMs);
    });
  });
}

module.exports = { discover, broadcastAddresses };
