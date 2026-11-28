'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { discover, broadcastAddresses } = require('../src/discovery');

test('broadcast addresses are computed from netmasks', () => {
  const addrs = broadcastAddresses({
    eth0: [{ family: 'IPv4', address: '192.168.0.23', netmask: '255.255.255.0', internal: false }],
    wg0: [{ family: 'IPv4', address: '10.8.0.2', netmask: '255.255.255.255', internal: false }],
    lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
  });
  assert.ok(addrs.includes('255.255.255.255'));
  assert.ok(addrs.includes('192.168.0.255'));
  assert.ok(addrs.includes('10.8.0.2'));
  assert.equal(addrs.some((a) => a.startsWith('127.')), false);
});

test('discover finds a console that answers the query', async () => {
  const server = dgram.createSocket('udp4');
  let queries = 0;
  await new Promise((r) => server.bind(0, '127.0.0.1', r));
  const port = server.address().port;
  server.on('message', (msg, rinfo) => {
    if (msg.toString() !== 'PS5SS?') return;
    queries++;
    const reply = 'PS5SS! ' + JSON.stringify({ app: 'ps5-screenshare', protocol: 1, port: 9700,
      ip: '127.0.0.1', firmware: '13.00', clients: 0, width: 1280, height: 720 });
    server.send(reply, rinfo.port, rinfo.address);
  });
  try {
    const found = await discover({ port, targets: ['127.0.0.1'], timeoutMs: 600 });
    assert.equal(found.length, 1);
    assert.equal(found[0].firmware, '13.00');
    assert.ok(queries >= 1);
  } finally {
    server.close();
  }
});

test('discover resolves empty when nothing answers', async () => {
  const found = await discover({ port: 1, targets: ['127.0.0.1'], timeoutMs: 300 });
  assert.deepEqual(found, []);
});
