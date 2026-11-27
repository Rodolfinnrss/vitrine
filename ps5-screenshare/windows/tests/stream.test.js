'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const P = require('../src/protocol');
const { Ps5Connection } = require('../src/stream');

function packetBytes(type, payload, pts) {
  const h = Buffer.alloc(16);
  h[0] = type;
  h.writeUInt32BE(payload.length, 4);
  h.writeBigUInt64BE(BigInt(pts || 0), 8);
  return Buffer.concat([h, payload]);
}

/** A fake console: sends the header and packets, records what the client writes. */
function fakeConsole(onConnection) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let got = '';
      sock.on('data', (d) => { got += d.toString(); });
      onConnection(sock, () => got);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function waitFor(pred, ms = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('timed out'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test('connection sends HELLO, reports ready and forwards packets in odd chunks', async () => {
  const received = [];
  let written = () => '';
  const server = await fakeConsole((sock, w) => {
    written = w;
    const bytes = Buffer.concat([
      Buffer.from([0x50, 0x53, 0x35, 0x53, 0, 1, 0, 0]),
      packetBytes(P.PKT.INFO, Buffer.from('{"width":1280}')),
      packetBytes(P.PKT.VIDEO, Buffer.alloc(3000, 9), 5),
    ]);
    // Deliver in uneven pieces, as a real socket would.
    let at = 0;
    const timer = setInterval(() => {
      if (at >= bytes.length) return clearInterval(timer);
      const n = 1 + ((at * 7) % 200);
      sock.write(bytes.subarray(at, at + n));
      at += n;
    }, 1);
  });
  const port = server.address().port;
  const conn = new Ps5Connection({ host: '127.0.0.1', port, hello: 'HELLO 1 audio=1' });
  let readyFired = false;
  conn.on('ready', () => { readyFired = true; });
  conn.on('packet', (p) => received.push(p));
  conn.connect();
  try {
    await waitFor(() => received.length === 2);
    assert.equal(readyFired, true);
    assert.equal(received[0].type, P.PKT.INFO);
    assert.equal(received[1].payload.length, 3000);
    assert.equal(received[1].pts, 5);
    await waitFor(() => written().startsWith('HELLO 1 audio=1\n'));
    assert.equal(conn.send('PAD 1,16384,128,128,128,128,0,0'), true);
    await waitFor(() => written().includes('PAD 1,16384,128,128,128,128,0,0\n'));
  } finally {
    conn.close();
    server.close();
  }
});

test('a server that is not the PS5 closes the connection with an error', async () => {
  const server = await fakeConsole((sock) => {
    sock.write('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  const conn = new Ps5Connection({ host: '127.0.0.1', port: server.address().port, hello: 'HELLO 1' });
  const events = [];
  conn.on('error', (e) => events.push(['error', e.message]));
  conn.on('close', (r) => events.push(['close', r]));
  conn.connect();
  try {
    await waitFor(() => events.length >= 2);
    assert.equal(events[0][0], 'error');
    assert.match(events[0][1], /nao e o PS5/);
    assert.equal(events.filter((e) => e[0] === 'close').length, 1, 'close is emitted once');
  } finally {
    server.close();
  }
});

test('silence from the console is reported after the idle timeout', async () => {
  const server = await fakeConsole((sock) => {
    sock.write(Buffer.from([0x50, 0x53, 0x35, 0x53, 0, 1, 0, 0]));
    // then nothing
  });
  const conn = new Ps5Connection({ host: '127.0.0.1', port: server.address().port, hello: 'HELLO 1',
    idleTimeoutMs: 200 });
  const errors = [];
  conn.on('error', (e) => errors.push(e.message));
  conn.connect();
  try {
    await waitFor(() => errors.length === 1, 2000);
    assert.match(errors[0], /Sem resposta/);
  } finally {
    conn.close();
    server.close();
  }
});

test('nothing listening: connect fails cleanly', async () => {
  const conn = new Ps5Connection({ host: '127.0.0.1', port: 1, hello: 'HELLO 1', connectTimeoutMs: 1000 });
  const closed = new Promise((r) => conn.on('close', r));
  conn.on('error', () => {});
  conn.connect();
  assert.ok(await closed);
});

test('send after close is ignored', async () => {
  const server = await fakeConsole(() => {});
  const conn = new Ps5Connection({ host: '127.0.0.1', port: server.address().port, hello: 'HELLO 1' });
  conn.on('error', () => {});
  conn.connect();
  await new Promise((r) => setTimeout(r, 50));
  conn.close();
  assert.equal(conn.send('KEY'), false);
  server.close();
});
