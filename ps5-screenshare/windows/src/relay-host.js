/* PS5 Screen Share - hospeda o servidor de encontro dentro do app do Windows.
 *
 * Quando ligado, este PC aceita as conexoes do PS5 e dos apps de fora de casa,
 * sem outro programa. Para os apps de fora alcancarem este PC, use o Tailscale
 * (gratuito) neste PC e no aparelho de fora: o endereco do Tailscale (100.x)
 * entra no app como servidor de acesso.
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

const os = require('node:os');
const { createRelay } = require('./relay-server');

const DEFAULT_PORT = 9800;

let relay = null;
let port = 0;
let sockets = new Set();

/** Starts listening on TCP port (0 = any free port, for tests). Resolves to the bound port. */
function start(requested) {
  const wanted = requested === undefined ? DEFAULT_PORT : Number(requested);
  if (relay) return Promise.resolve(port);
  const r = createRelay({ log: (msg) => console.log(new Date().toISOString() + ' ' + msg) });
  const socks = new Set();
  r.server.on('connection', (s) => {
    socks.add(s);
    s.once('close', () => socks.delete(s));
  });
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      r.server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      r.server.removeListener('error', onError);
      relay = r;
      sockets = socks;
      port = r.server.address().port;
      resolve(port);
    };
    r.server.once('error', onError);
    r.server.once('listening', onListening);
    r.server.listen(wanted, '0.0.0.0');
  });
}

/** Stops listening and ends every tunnel that is open. */
function stop() {
  if (!relay) return Promise.resolve();
  const r = relay;
  relay = null;
  port = 0;
  for (const s of sockets) s.destroy();
  sockets = new Set();
  return new Promise((resolve) => r.server.close(() => resolve()));
}

function isRunning() {
  return relay !== null;
}

function runningPort() {
  return port;
}

function stats() {
  return relay ? relay.stats() : null;
}

/** Splits this PC's IPv4 addresses into Tailscale (100.64.0.0/10) and home network. */
function addresses(ifaces) {
  const list = ifaces || os.networkInterfaces();
  const vpn = [];
  const lan = [];
  for (const entries of Object.values(list)) {
    for (const a of entries || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address;
      if (isTailscale(ip)) vpn.push(ip);
      else if (isPrivate(ip)) lan.push(ip);
    }
  }
  return { lan, vpn };
}

function isTailscale(ip) {
  const m = /^100\.(\d{1,3})\./.exec(ip);
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

function isPrivate(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\./.exec(ip);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

module.exports = {
  DEFAULT_PORT,
  start,
  stop,
  isRunning,
  runningPort,
  stats,
  addresses,
};
