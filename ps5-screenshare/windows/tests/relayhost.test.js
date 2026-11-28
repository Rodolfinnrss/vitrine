'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const RelayHost = require('../src/relay-host');
const { SRC, DST } = require('../scripts/sync-relay');

test('the bundled relay is an exact copy of relay/server.js', (t) => {
  if (!fs.existsSync(SRC)) return t.skip('relay/ not present');
  assert.ok(fs.readFileSync(DST).equals(fs.readFileSync(SRC)), 'run: node scripts/sync-relay.js');
});

test('hosting starts on a free port and stops cleanly', async () => {
  const port = await RelayHost.start(0);
  assert.ok(port > 0);
  assert.equal(RelayHost.isRunning(), true);
  assert.equal(RelayHost.runningPort(), port);
  assert.equal(await RelayHost.start(0), port, 'a second start keeps the same server');
  await RelayHost.stop();
  assert.equal(RelayHost.isRunning(), false);
  await RelayHost.stop(); // stopping twice is harmless
});

test('the hosted relay answers apps like the standalone one', async () => {
  const port = await RelayHost.start(0);
  try {
    const answer = await new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', () => s.write('SUB 0123456789abcdef\n'));
      let buf = '';
      s.on('data', (c) => (buf += c.toString('ascii')));
      s.on('end', () => resolve(buf));
      s.on('close', () => resolve(buf));
      s.on('error', reject);
    });
    assert.equal(answer.trim(), 'NOCONSOLE', 'no PS5 registered under that id');
  } finally {
    await RelayHost.stop();
  }
});

test('an open tunnel is ended when hosting stops', async () => {
  const port = await RelayHost.start(0);
  const s = net.connect(port, '127.0.0.1');
  await new Promise((resolve) => s.once('connect', resolve));
  s.write('PUB 0123456789abcdef\n');
  const closed = new Promise((resolve) => s.once('close', resolve));
  await new Promise((resolve) => s.once('data', resolve));
  await RelayHost.stop();
  await closed;
  assert.equal(RelayHost.isRunning(), false);
});

test('a busy port is reported, not swallowed', async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '0.0.0.0', resolve));
  try {
    await assert.rejects(RelayHost.start(blocker.address().port), /EADDRINUSE/);
    assert.equal(RelayHost.isRunning(), false);
  } finally {
    blocker.close();
  }
});

test('addresses split Tailscale (100.64/10) from the home network', () => {
  const ifaces = {
    'Ethernet': [
      { family: 'IPv4', address: '192.168.0.23', internal: false },
      { family: 'IPv6', address: 'fe80::1', internal: false },
    ],
    'Tailscale': [{ family: 'IPv4', address: '100.101.102.103', internal: false }],
    'Loopback': [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    'Other': [{ family: 'IPv4', address: '100.200.1.1', internal: false }],
    'VPN': [{ family: 'IPv4', address: '172.20.0.5', internal: false }],
  };
  const a = RelayHost.addresses(ifaces);
  assert.deepEqual(a.vpn, ['100.101.102.103']);
  assert.deepEqual(a.lan.sort(), ['172.20.0.5', '192.168.0.23']);
});

test('the test file does not leave the relay running', async () => {
  await RelayHost.stop();
  assert.equal(RelayHost.isRunning(), false);
  assert.ok(path.isAbsolute(DST));
});
