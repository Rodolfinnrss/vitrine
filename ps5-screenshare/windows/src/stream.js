/* PS5 Screen Share - one TCP connection to the console (Electron main process).
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Events: 'ready' (stream header received), 'packet' (one parsed packet),
 * 'error' (Error) and 'close' (reason string). 'close' is emitted once.
 */
'use strict';

const net = require('node:net');
const { EventEmitter } = require('node:events');
const Protocol = require('./protocol');

class Ps5Connection extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.host
   * @param {number} [o.port]
   * @param {string} o.hello       first line, from Protocol.buildHello()
   * @param {number} [o.connectTimeoutMs]
   * @param {number} [o.idleTimeoutMs]  the console sends keepalives every second
   */
  constructor(o) {
    super();
    this.host = o.host;
    this.port = o.port || Protocol.DEFAULT_PORT;
    this.hello = o.hello;
    this.connectTimeoutMs = o.connectTimeoutMs || 5000;
    this.idleTimeoutMs = o.idleTimeoutMs || 6000;
    this.parser = new Protocol.StreamParser();
    this.socket = null;
    this.idleTimer = null;
    this.ready = false;
    this.closed = false;
    this.bytes = 0;
  }

  connect() {
    const sock = net.createConnection({ host: this.host, port: this.port });
    this.socket = sock;
    sock.setNoDelay(true);
    sock.setTimeout(this.connectTimeoutMs, () => this.fail(new Error('Tempo esgotado ao conectar em ' + this.host)));
    sock.once('connect', () => {
      sock.setTimeout(0);
      sock.write(this.hello + '\n');
      this.armIdle();
    });
    sock.on('data', (chunk) => this.onData(chunk));
    sock.on('error', (err) => this.fail(err));
    sock.on('close', () => this.finish('Conexão encerrada'));
    return this;
  }

  onData(chunk) {
    this.bytes += chunk.length;
    this.armIdle();
    let packets;
    try {
      packets = this.parser.feed(chunk);
    } catch (err) {
      this.fail(err);
      return;
    }
    if (!this.ready && this.parser.headerDone) {
      this.ready = true;
      this.emit('ready');
    }
    for (const p of packets) {
      if (this.closed) return;
      this.emit('packet', p);
    }
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.fail(new Error('Sem resposta do PS5 (verifique a rede ou a VPN)'));
    }, this.idleTimeoutMs);
  }

  /** Writes one command line. Ignored after the connection is closed. */
  send(line) {
    if (this.closed || !this.socket || !this.socket.writable) return false;
    this.socket.write(line + '\n');
    return true;
  }

  fail(err) {
    if (this.closed) return;
    this.emit('error', err);
    this.finish(err.message);
  }

  finish(reason) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    if (this.socket) {
      this.socket.removeAllListeners('close');
      this.socket.destroy();
    }
    this.emit('close', reason);
  }

  close() {
    if (this.socket && !this.closed && this.socket.writable) this.send('BYE');
    this.finish('Desconectado');
  }
}

module.exports = { Ps5Connection };
