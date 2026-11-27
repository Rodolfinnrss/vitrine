#!/usr/bin/env node
/* PS5 Screen Share - relay (servidor de encontro).
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * O PS5 e o app se conectam a este servidor por SAIDA (o roteador deixa passar),
 * então ninguem precisa abrir porta nem configurar VPN. O servidor so encaminha
 * bytes: a conexao e criptografada de ponta a ponta com a chave do PS5, entao
 * ele nao consegue ver nem alterar a imagem ou os comandos.
 *
 * Protocolo (primeira linha de cada conexao, terminada em \n):
 *   PUB <id>      o PS5 se registra. Responde "OK" e depois recebe "OPEN <sid>"
 *                 sempre que um app quer se conectar.
 *   DATA <sid>    o PS5 abre uma conexao nova para um app. Vira um tunel.
 *   SUB <id>      o app pede o PS5. Recebe "OK" quando o tunel esta pronto, ou
 *                 NOCONSOLE / BUSY / TIMEOUT / BADSID antes.
 * O PS5 envia "PING" a cada 20 s; sem nada por 60 s o registro e descartado.
 */
'use strict';

const net = require('node:net');
const crypto = require('node:crypto');

const DEFAULTS = {
  pendingMs: 10000,   // tempo para o PS5 abrir o tunel depois de OPEN
  silentMs: 60000,    // registro do PS5 sem nenhuma linha por tanto tempo e descartado
  firstLineMs: 10000, // conexao que nao manda a primeira linha
  maxPending: 8,      // pedidos de app aguardando um tunel, por PS5
  maxViewers: 4,      // tuneis ativos por PS5 (o PS5 aceita 4 clientes)
  lineMax: 256,
};

function createRelay(options) {
  const o = Object.assign({}, DEFAULTS, options || {});
  const log = o.log || (() => {});
  /** id -> { id, sock, pending: Map(sid -> {client, timer, rest}), active, lastSeen } */
  const consoles = new Map();

  const shortId = (id) => id.slice(0, 6);
  const reply = (sock, text) => {
    try {
      sock.end(text);
    } catch (e) {
      sock.destroy();
    }
  };

  /** Reads up to the first newline. cb(line, rest) or cb(null) if the line is missing or too long. */
  function readFirstLine(sock, cb) {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0 && buf.length <= o.lineMax) return;
      sock.removeListener('data', onData);
      sock.pause();
      if (nl < 0 || nl > o.lineMax) return cb(null);
      cb(buf.subarray(0, nl).toString('ascii').replace(/\r$/, ''), buf.subarray(nl + 1));
    };
    sock.on('data', onData);
  }

  function onConsole(sock, id) {
    const old = consoles.get(id);
    if (old) {
      log('registro substituido ' + shortId(id));
      old.sock.destroy();
    }
    const entry = { id, sock, pending: new Map(), active: 0, lastSeen: Date.now() };
    consoles.set(id, entry);
    sock.resume();
    sock.on('data', () => {
      entry.lastSeen = Date.now();
    });
    sock.write('OK\n');
    log('PS5 registrado ' + shortId(id));
    const watch = setInterval(() => {
      if (Date.now() - entry.lastSeen > o.silentMs) sock.destroy();
    }, Math.min(5000, o.silentMs));
    sock.on('close', () => {
      clearInterval(watch);
      if (consoles.get(id) === entry) consoles.delete(id);
      for (const p of entry.pending.values()) {
        clearTimeout(p.timer);
        reply(p.client, 'NOCONSOLE\n');
      }
      entry.pending.clear();
      log('PS5 desconectado ' + shortId(id));
    });
  }

  function onViewer(sock, id, rest) {
    const c = consoles.get(id);
    if (!c) return reply(sock, 'NOCONSOLE\n');
    if (c.pending.size + c.active >= o.maxViewers || c.pending.size >= o.maxPending) {
      return reply(sock, 'BUSY\n');
    }
    const sid = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => {
      c.pending.delete(sid);
      reply(sock, 'TIMEOUT\n');
    }, o.pendingMs);
    c.pending.set(sid, { client: sock, timer, rest });
    sock.on('close', () => {
      clearTimeout(timer);
      c.pending.delete(sid);
    });
    c.sock.write('OPEN ' + sid + '\n');
  }

  function onTunnel(sock, sid, rest) {
    let owner = null;
    for (const c of consoles.values()) {
      if (c.pending.has(sid)) {
        owner = c;
        break;
      }
    }
    if (!owner) return reply(sock, 'BADSID\n');
    const p = owner.pending.get(sid);
    owner.pending.delete(sid);
    clearTimeout(p.timer);
    const client = p.client;
    if (client.destroyed) return sock.destroy();
    owner.active++;
    client.write('OK\n');
    // Bytes the PS5 sent before the tunel was paired belong to the app, and the
    // app's bytes sent before pairing belong to the PS5.
    if (rest && rest.length) client.write(rest);
    if (p.rest && p.rest.length) sock.write(p.rest);
    client.pipe(sock);
    sock.pipe(client);
    client.resume();
    sock.resume();
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      owner.active--;
      client.destroy();
      sock.destroy();
    };
    client.on('close', done);
    client.on('error', done);
    sock.on('close', done);
    sock.on('error', done);
  }

  const server = net.createServer((sock) => {
    sock.setNoDelay(true);
    const idle = setTimeout(() => sock.destroy(), o.firstLineMs);
    readFirstLine(sock, (line, rest) => {
      clearTimeout(idle);
      if (line === null) return reply(sock, 'BADREQUEST\n');
      const m = /^(PUB|SUB|DATA) ([0-9a-f]{16})$/.exec(line);
      if (!m) return reply(sock, 'BADREQUEST\n');
      if (m[1] === 'PUB') return onConsole(sock, m[2]);
      if (m[1] === 'SUB') return onViewer(sock, m[2], rest);
      return onTunnel(sock, m[2], rest);
    });
    sock.on('error', () => sock.destroy());
  });

  return {
    server,
    consoles,
    stats: () => ({
      consoles: consoles.size,
      viewers: [...consoles.values()].reduce((n, c) => n + c.active, 0),
    }),
  };
}

function main() {
  const port = Number(process.argv[2] || process.env.PORT || 9800);
  const host = process.env.HOST || '0.0.0.0';
  const relay = createRelay({
    log: (msg) => console.log(new Date().toISOString() + ' ' + msg),
  });
  relay.server.listen(port, host, () => {
    console.log('PS5 Screen Share relay ouvindo em ' + host + ':' + port);
  });
}

if (require.main === module) main();

module.exports = { createRelay, DEFAULTS };
