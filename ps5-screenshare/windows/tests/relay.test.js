'use strict';
/* The app's relay mode against the real relay server, with a console written
 * from the PS5 side of the spec (relay/PROTOCOL.md). The payload itself is
 * covered by payload/tools/host_test.py and the end-to-end test. */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const { createRelay } = require('../../relay/server');
const S = require('../src/secure');
const P = require('../src/protocol');
const { Ps5Connection, RELAY_MESSAGES } = require('../src/stream');

const SECRET = crypto.randomBytes(16);

function startRelay() {
  const relay = createRelay({ pendingMs: 3000, firstLineMs: 3000 });
  return new Promise((resolve) => relay.server.listen(0, '127.0.0.1', () => resolve({ relay, port: relay.server.address().port })));
}

function lineReader(sock, onLine) {
  let buf = Buffer.alloc(0);
  let done = false;
  sock.on('data', (c) => {
    if (done) return;
    buf = Buffer.concat([buf, c]);
    const nl = buf.indexOf(0x0a);
    if (nl >= 0) {
      done = true;
      const rest = buf.subarray(nl + 1);
      onLine(buf.subarray(0, nl).toString('ascii'), rest);
    }
  });
}

/** The PS5 side: registers, answers OPEN with a tunnel, serves one viewer. */
function fakeConsole(port, secret, onViewer) {
  const id = S.pairingId(secret);
  const key = S.pairingKey(secret);
  const ctl = net.connect(port, '127.0.0.1', () => ctl.write('PUB ' + id + '\n'));
  ctl.on('error', () => {});
  lineReader(ctl, () => {});
  ctl.on('data', (chunk) => {
    for (const line of chunk.toString('ascii').split('\n')) {
      if (!line.startsWith('OPEN ')) continue;
      const data = net.connect(port, '127.0.0.1', () => {
        data.write('DATA ' + line.slice(5) + '\n');
        const salt = crypto.randomBytes(16);
        data.write('SALT ' + salt.toString('hex') + '\n');
        const sk = S.sessionKey(key, salt);
        onViewer(data, sk);
      });
      data.on('error', () => {});
    }
  });
  return { close: () => ctl.destroy() };
}

function serveViewer(sock, sk, opts) {
  const reader = new S.FrameReader(sk, S.DIR_CLIENT);
  let txSeq = 0;
  const sendPacket = (type, payload, pts) => {
    const h = Buffer.alloc(16);
    h[0] = type;
    h.writeUInt32BE(payload.length, 4);
    h.writeBigUInt64BE(BigInt(pts || 0), 8);
    sock.write(S.sealFrame(sk, S.DIR_SERVER, txSeq++, Buffer.concat([h, payload])));
  };
  let hello = false;
  let rxSeen = 0;
  sock.on('data', (chunk) => {
    let plains;
    try {
      plains = reader.feed(chunk);
    } catch (e) {
      sock.destroy();
      return;
    }
    for (const plain of plains) {
      if (!hello) {
        hello = true;
        if (opts.onHello) opts.onHello(plain.toString('utf8'));
        sock.write(S.sealFrame(sk, S.DIR_SERVER, txSeq++, Buffer.from('PS5S\x00\x01\x00\x00', 'latin1')));
        opts.onReady && opts.onReady(sendPacket);
        continue;
      }
      rxSeen++;
      opts.onCommand && opts.onCommand(plain.toString('utf8'));
    }
  });
  return { sendPacket, received: () => rxSeen };
}

test('an app reaches the console through the relay and gets the stream', async () => {
  const { relay, port } = await startRelay();
  const console_ = fakeConsole(port, SECRET, (sock, sk) => {
    serveViewer(sock, sk, {
      onReady: (send) => {
        send(P.PKT.INFO, Buffer.from('{"width":1280,"height":720}'));
        send(P.PKT.VIDEO, Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3]), 1000);
      },
    });
  });
  await new Promise((r) => setTimeout(r, 100));
  const conn = new Ps5Connection({
    host: '127.0.0.1', port, relaySecret: SECRET,
    hello: 'HELLO 1 audio=0 res=720p fps=60', idleTimeoutMs: 4000,
  });
  const got = [];
  const ready = new Promise((res, rej) => {
    conn.on('ready', res);
    conn.on('error', rej);
  });
  conn.on('packet', (p) => got.push(p));
  conn.connect();
  try {
    await ready;
    for (let i = 0; i < 100 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(got.length, 2);
    assert.equal(got[0].type, P.PKT.INFO);
    assert.equal(JSON.parse(Buffer.from(got[0].payload).toString()).width, 1280);
    assert.equal(got[1].type, P.PKT.VIDEO);
    assert.equal(got[1].pts, 1000);
    assert.equal(got[1].payload.length, 8);
  } finally {
    conn.close();
    console_.close();
    relay.server.close();
  }
});

test('commands from the app arrive at the console, sealed and in order', async () => {
  const { relay, port } = await startRelay();
  const seen = [];
  const console_ = fakeConsole(port, SECRET, (sock, sk) => {
    serveViewer(sock, sk, { onCommand: (line) => seen.push(line) });
  });
  await new Promise((r) => setTimeout(r, 100));
  const conn = new Ps5Connection({ host: '127.0.0.1', port, relaySecret: SECRET, hello: 'HELLO 1 audio=0 res=720p fps=60', idleTimeoutMs: 4000 });
  conn.on('error', () => {});
  const ready = new Promise((res) => conn.on('ready', res));
  conn.connect();
  try {
    await ready;
    assert.equal(conn.send('PAD 1,16384,128,128,128,128,0,0'), true);
    assert.equal(conn.send('PAD 2,0,128,128,128,128,0,0'), true);
    assert.equal(conn.send('KEY'), true);
    for (let i = 0; i < 100 && seen.length < 3; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seen, ['PAD 1,16384,128,128,128,128,0,0', 'PAD 2,0,128,128,128,128,0,0', 'KEY']);
  } finally {
    conn.close();
    console_.close();
    relay.server.close();
  }
});

test('a wrong pairing code never gets a stream', async () => {
  const { relay, port } = await startRelay();
  const wrong = crypto.randomBytes(16);
  let sentAnything = false;
  const console_ = fakeConsole(port, SECRET, (sock, sk) => {
    serveViewer(sock, sk, {
      onReady: (send) => {
        sentAnything = true;
        send(P.PKT.INFO, Buffer.from('{"secret":"should not leak"}'));
      },
    });
  });
  await new Promise((r) => setTimeout(r, 100));
  // The right console id, but a key derived from the wrong code.
  const conn = new Ps5Connection({
    host: '127.0.0.1', port, relaySecret: wrong, relayId: S.pairingId(SECRET),
    hello: 'HELLO 1 audio=0 res=720p fps=60', idleTimeoutMs: 4000,
  });
  let ready = false;
  conn.on('ready', () => { ready = true; });
  conn.on('error', () => {});
  const closed = new Promise((res) => conn.on('close', res));
  conn.connect();
  try {
    await closed;
    assert.equal(ready, false, 'no stream for the wrong code');
    assert.equal(sentAnything, false, 'the console sends nothing to an unproven client');
  } finally {
    conn.close();
    console_.close();
    relay.server.close();
  }
});

test('no console on the relay: the app is told so', async () => {
  const { relay, port } = await startRelay();
  const conn = new Ps5Connection({ host: '127.0.0.1', port, relaySecret: SECRET, hello: 'HELLO 1', idleTimeoutMs: 4000 });
  const msg = await new Promise((res) => {
    conn.on('error', (e) => res(e.message));
    conn.connect();
  });
  assert.equal(msg, RELAY_MESSAGES.NOCONSOLE);
  conn.close();
  relay.server.close();
});
