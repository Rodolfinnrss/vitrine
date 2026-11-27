'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const { createRelay } = require('../server');

const ID = 'a1b2c3d4e5f60718';

function start(opts) {
  const relay = createRelay(Object.assign({ pendingMs: 400, firstLineMs: 500 }, opts || {}));
  return new Promise((resolve) => {
    relay.server.listen(0, '127.0.0.1', () => resolve({ relay, port: relay.server.address().port }));
  });
}

/** Line-oriented reader: next() resolves with the next line, or the rest of the data as bytes. */
function reader(sock) {
  let buf = Buffer.alloc(0);
  const waiters = [];
  let ended = false;
  sock.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    pump();
  });
  sock.on('close', () => {
    ended = true;
    pump();
  });
  function pump() {
    while (waiters.length) {
      const w = waiters[0];
      if (w.bytes) {
        if (buf.length < w.bytes && !ended) return;
        waiters.shift();
        const out = buf.subarray(0, w.bytes);
        buf = buf.subarray(w.bytes);
        w.resolve(out);
      } else {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) {
          if (!ended) return;
          waiters.shift();
          w.resolve(null);
          continue;
        }
        waiters.shift();
        const line = buf.subarray(0, nl).toString('ascii');
        buf = buf.subarray(nl + 1);
        w.resolve(line);
      }
    }
  }
  return {
    line: () => new Promise((resolve) => { waiters.push({ resolve }); pump(); }),
    bytes: (n) => new Promise((resolve) => { waiters.push({ bytes: n, resolve }); pump(); }),
    closed: () => new Promise((resolve) => (ended ? resolve(true) : sock.once('close', () => resolve(true)))),
  };
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host: '127.0.0.1', port }, () => resolve(s));
    s.on('error', reject);
  });
}

async function console_(port, id) {
  const s = await connect(port);
  const r = reader(s);
  s.write('PUB ' + id + '\n');
  assert.equal(await r.line(), 'OK');
  return { sock: s, r };
}

test('a viewer and a console are paired and bytes flow both ways', async () => {
  const { relay, port } = await start();
  try {
    const c = await console_(port, ID);
    const v = await connect(port);
    const vr = reader(v);
    v.write('SUB ' + ID + '\n');
    const open = await c.r.line();
    assert.match(open, /^OPEN [0-9a-f]{16}$/);
    const sid = open.slice(5);

    const t = await connect(port);
    const tr = reader(t);
    t.write('DATA ' + sid + '\n');
    t.write('SALT-FROM-PS5\n'); // sent before the viewer is paired, must reach the app
    assert.equal(await vr.line(), 'OK');
    assert.equal(await vr.line(), 'SALT-FROM-PS5');

    v.write('HELLO-FROM-APP\n'); // the app's first bytes must reach the PS5
    assert.equal(await tr.line(), 'HELLO-FROM-APP');
    t.write('ANSWER\n');
    assert.equal(await vr.line(), 'ANSWER');
    assert.equal(relay.stats().viewers, 1);

    v.destroy();
    await tr.closed();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(relay.stats().viewers, 0);
    c.sock.destroy();
  } finally {
    relay.server.close();
  }
});

test('a viewer that asks for an unknown console gets NOCONSOLE', async () => {
  const { relay, port } = await start();
  try {
    const v = await connect(port);
    const vr = reader(v);
    v.write('SUB ' + ID + '\n');
    assert.equal(await vr.line(), 'NOCONSOLE');
  } finally {
    relay.server.close();
  }
});

test('a console that never opens the tunnel makes the viewer time out', async () => {
  const { relay, port } = await start({ pendingMs: 150 });
  try {
    const c = await console_(port, ID);
    const v = await connect(port);
    const vr = reader(v);
    v.write('SUB ' + ID + '\n');
    assert.match(await c.r.line(), /^OPEN /);
    assert.equal(await vr.line(), 'TIMEOUT');
    c.sock.destroy();
  } finally {
    relay.server.close();
  }
});

test('a tunnel with an unknown session id is refused', async () => {
  const { relay, port } = await start();
  try {
    const t = await connect(port);
    const tr = reader(t);
    t.write('DATA 0000000000000000\n');
    assert.equal(await tr.line(), 'BADSID');
  } finally {
    relay.server.close();
  }
});

test('malformed first lines are rejected', async () => {
  const { relay, port } = await start();
  try {
    for (const bad of ['HELLO 1\n', 'PUB xyz\n', 'SUB A1B2C3D4E5F60718\n', 'PUB ' + ID + ' extra\n']) {
      const s = await connect(port);
      const r = reader(s);
      s.write(bad);
      assert.equal(await r.line(), 'BADREQUEST', JSON.stringify(bad));
    }
    const s = await connect(port);
    const r = reader(s);
    s.write('x'.repeat(400)); // no newline within the limit
    assert.equal(await r.line(), 'BADREQUEST');
  } finally {
    relay.server.close();
  }
});

test('a silent connection is dropped', async () => {
  const { relay, port } = await start({ firstLineMs: 120 });
  try {
    const s = await connect(port);
    const r = reader(s);
    assert.equal(await r.closed(), true);
  } finally {
    relay.server.close();
  }
});

test('a second console with the same id replaces the first', async () => {
  const { relay, port } = await start();
  try {
    const first = await console_(port, ID);
    const firstClosed = first.r.closed();
    const second = await console_(port, ID);
    await firstClosed;
    assert.equal(relay.consoles.get(ID).sock.remoteAddress !== undefined, true);
    const v = await connect(port);
    reader(v).line();
    v.write('SUB ' + ID + '\n');
    assert.match(await second.r.line(), /^OPEN /);
    second.sock.destroy();
    v.destroy();
  } finally {
    relay.server.close();
  }
});

test('the console going away ends its pending viewers', async () => {
  const { relay, port } = await start({ pendingMs: 5000 });
  try {
    const c = await console_(port, ID);
    const v = await connect(port);
    const vr = reader(v);
    v.write('SUB ' + ID + '\n');
    await c.r.line();
    c.sock.destroy();
    assert.equal(await vr.line(), 'NOCONSOLE');
  } finally {
    relay.server.close();
  }
});

test('viewers beyond the limit are told BUSY', async () => {
  const { relay, port } = await start({ maxViewers: 2 });
  try {
    const c = await console_(port, ID);
    const sockets = [];
    for (let i = 0; i < 2; i++) {
      const v = await connect(port);
      v.write('SUB ' + ID + '\n');
      sockets.push(v);
      await c.r.line();
    }
    const v3 = await connect(port);
    const r3 = reader(v3);
    v3.write('SUB ' + ID + '\n');
    assert.equal(await r3.line(), 'BUSY');
    c.sock.destroy();
    sockets.forEach((s) => s.destroy());
  } finally {
    relay.server.close();
  }
});

test('stats and random session ids do not repeat', async () => {
  const { relay, port } = await start();
  try {
    const c = await console_(port, ID);
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
      const v = await connect(port);
      v.write('SUB ' + ID + '\n');
      const open = await c.r.line();
      seen.add(open);
      v.destroy();
    }
    assert.equal(seen.size, 20);
    assert.equal(relay.stats().consoles, 1);
    c.sock.destroy();
    assert.ok(crypto.randomBytes(8).length === 8);
  } finally {
    relay.server.close();
  }
});
