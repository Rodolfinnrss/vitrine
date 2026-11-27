/* PS5 Screen Share - one connection to the console (Electron main process).
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Two ways in:
 *   LAN:    straight to the console; the stream is plain (as on the LAN).
 *   Relay:  to the relay server, which hands the connection to the console. The
 *           stream is sealed end to end with the pairing code (relay/PROTOCOL.md).
 *
 * Events: 'ready' (the console answered), 'packet' (one packet), 'error'
 * (Error) and 'close' (reason string). 'close' is emitted once.
 */
'use strict';

const net = require('node:net');
const { EventEmitter } = require('node:events');
const Protocol = require('./protocol');
const Secure = require('./secure');

const RELAY_MESSAGES = {
  NOCONSOLE: 'O PS5 não está conectado ao servidor. Confira se o payload está rodando com relay= configurado.',
  BUSY: 'Este PS5 já tem o número máximo de aparelhos conectados.',
  TIMEOUT: 'O PS5 não respondeu ao pedido de conexão.',
  BADSID: 'O servidor recusou a conexão do PS5.',
  BADREQUEST: 'O servidor não entendeu o pedido.',
};

class Ps5Connection extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.host            console address (LAN) or relay host
   * @param {number} [o.port]          console port (LAN) or relay port
   * @param {string} o.hello           HELLO line, from Protocol.buildHello()
   * @param {Buffer} [o.relaySecret]   16-byte pairing secret: connect through the relay
   * @param {string} [o.relayId]       routing id, when it is not derived from the secret (tests)
   * @param {number} [o.connectTimeoutMs]
   * @param {number} [o.idleTimeoutMs] the console sends keepalives every second
   */
  constructor(o) {
    super();
    this.host = o.host;
    this.port = o.port || Protocol.DEFAULT_PORT;
    this.hello = o.hello;
    this.relaySecret = o.relaySecret || null;
    this.relayId = o.relayId || null;
    this.connectTimeoutMs = o.connectTimeoutMs || 5000;
    this.idleTimeoutMs = o.idleTimeoutMs || 6000;
    this.parser = new Protocol.StreamParser();
    this.socket = null;
    this.idleTimer = null;
    this.phase = 'idle'; // 'lan' | 'ok' | 'salt' | 'frames'
    this.pre = Buffer.alloc(0);
    this.key = null;
    this.reader = null;
    this.txSeq = 0;
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
      if (this.relaySecret) {
        const id = this.relayId || Secure.pairingId(this.relaySecret);
        this.phase = 'ok';
        sock.write('SUB ' + id + '\n');
      } else {
        this.phase = 'lan';
        sock.write(this.hello + '\n');
      }
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
    if (this.phase === 'lan') {
      this.onLanBytes(chunk);
    } else if (this.phase === 'frames') {
      this.onFrames(chunk);
    } else {
      this.pre = this.pre.length ? Buffer.concat([this.pre, chunk]) : chunk;
      this.onRelayLines();
    }
  }

  onLanBytes(chunk) {
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

  /** Relay handshake: 'OK' from the relay, then 'SALT' from the console. */
  onRelayLines() {
    for (;;) {
      if (this.closed) return;
      const nl = this.pre.indexOf(0x0a);
      if (nl < 0) {
        if (this.pre.length > 256) this.fail(new Error('Resposta inválida do servidor'));
        return;
      }
      const line = this.pre.subarray(0, nl).toString('ascii').replace(/\r$/, '');
      this.pre = this.pre.subarray(nl + 1);
      if (this.phase === 'ok') {
        if (line !== 'OK') {
          this.fail(new Error(RELAY_MESSAGES[line] || 'Resposta inesperada do servidor: ' + line));
          return;
        }
        this.phase = 'salt';
        continue;
      }
      // phase 'salt'
      if (!/^SALT [0-9a-f]{32}$/.test(line)) {
        this.fail(new Error('O PS5 não iniciou a sessão corretamente'));
        return;
      }
      this.key = Secure.sessionKey(Secure.pairingKey(this.relaySecret), Buffer.from(line.slice(5), 'hex'));
      this.reader = new Secure.FrameReader(this.key, Secure.DIR_SERVER);
      this.phase = 'frames';
      this.sendFrame(this.hello);
      const rest = this.pre;
      this.pre = Buffer.alloc(0);
      if (rest.length) this.onFrames(rest);
      return;
    }
  }

  onFrames(chunk) {
    let plains;
    try {
      plains = this.reader.feed(chunk);
    } catch (err) {
      this.fail(new Error('Conexão recusada: o código de pareamento não confere'));
      return;
    }
    for (const plain of plains) {
      if (this.closed) return;
      if (!this.ready) {
        if (plain.length !== 8 || plain.toString('latin1', 0, 4) !== 'PS5S') {
          this.fail(new Error('Stream inválido'));
          return;
        }
        this.ready = true;
        this.emit('ready');
        continue;
      }
      const p = Protocol.parsePacket(plain);
      if (!p) {
        this.fail(new Error('Pacote inválido'));
        return;
      }
      this.emit('packet', p);
    }
  }

  sendFrame(line) {
    const frame = Secure.sealFrame(this.key, Secure.DIR_CLIENT, this.txSeq, Buffer.from(line, 'utf8'));
    this.txSeq++;
    this.socket.write(frame);
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.fail(new Error('Sem resposta do PS5' + (this.relaySecret ? ' pelo servidor' : ' (verifique a rede ou a VPN)')));
    }, this.idleTimeoutMs);
  }

  /** Sends one command line. Returns false if the session is not open. */
  send(line) {
    if (this.closed || !this.socket || !this.socket.writable) return false;
    if (this.relaySecret) {
      if (this.phase !== 'frames') return false;
      this.sendFrame(line);
      return true;
    }
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
    if (this.socket && !this.closed && this.socket.writable) {
      if (this.relaySecret) {
        if (this.phase === 'frames') this.sendFrame('BYE');
      } else {
        this.send('BYE');
      }
    }
    this.finish('Desconectado');
  }
}

module.exports = { Ps5Connection, RELAY_MESSAGES };
