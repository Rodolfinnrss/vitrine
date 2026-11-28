'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../src/secure');

const VEC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'relay', 'test', 'vectors.json'), 'utf8'));

test('pairing: id and key match the shared vectors', () => {
  for (const v of VEC.pairing) {
    const secret = Buffer.from(v.secret, 'hex');
    assert.equal(S.pairingId(secret), v.id);
    assert.equal(S.pairingKey(secret).toString('hex'), v.key);
  }
});

test('session keys match the shared vectors', () => {
  for (const v of VEC.session) {
    assert.equal(S.sessionKey(Buffer.from(v.key, 'hex'), Buffer.from(v.salt, 'hex')).toString('hex'), v.sessionKey);
  }
});

test('frames: sealing reproduces the vectors, opening recovers the plaintext', () => {
  for (const v of VEC.frames) {
    const key = Buffer.from(v.key, 'hex');
    const plain = Buffer.from(v.plain, 'hex');
    const sealed = S.sealFrame(key, v.dir, v.seq, plain);
    assert.equal(sealed.readUInt32BE(0), Buffer.from(v.body, 'hex').length);
    assert.equal(sealed.subarray(4).toString('hex'), v.body);
    assert.equal(S.openBody(key, v.dir, v.seq, Buffer.from(v.body, 'hex')).toString('hex'), v.plain);
  }
});

test('frames: a wrong sequence number, direction or key does not open', () => {
  const v = VEC.frames[5];
  const key = Buffer.from(v.key, 'hex');
  const body = Buffer.from(v.body, 'hex');
  assert.throws(() => S.openBody(key, v.dir, v.seq + 1, body));
  assert.throws(() => S.openBody(key, v.dir === 0x43 ? 0x53 : 0x43, v.seq, body));
  const other = Buffer.from(key);
  other[0] ^= 1;
  assert.throws(() => S.openBody(other, v.dir, v.seq, body));
  const flipped = Buffer.from(body);
  flipped[3] ^= 0x80;
  assert.throws(() => S.openBody(key, v.dir, v.seq, flipped));
});

test('FrameReader: any split of the bytes gives the same frames', () => {
  const key = Buffer.alloc(32, 7);
  const parts = [];
  for (let i = 0; i < 40; i++) {
    parts.push(S.sealFrame(key, S.DIR_SERVER, i, Buffer.alloc(i * 37 % 300, i)));
  }
  const all = Buffer.concat(parts);
  for (const step of [1, 3, 17, 255, all.length]) {
    const r = new S.FrameReader(key, S.DIR_SERVER);
    const got = [];
    for (let at = 0; at < all.length; at += step) {
      got.push(...r.feed(all.subarray(at, Math.min(all.length, at + step))));
    }
    assert.equal(got.length, 40, 'step ' + step);
    got.forEach((g, i) => assert.equal(g.length, i * 37 % 300, 'frame ' + i));
  }
});

test('FrameReader: a replayed or reordered frame stops the stream', () => {
  const key = Buffer.alloc(32, 9);
  const a = S.sealFrame(key, S.DIR_SERVER, 0, Buffer.from('a'));
  const b = S.sealFrame(key, S.DIR_SERVER, 1, Buffer.from('b'));
  assert.throws(() => new S.FrameReader(key, S.DIR_SERVER).feed(Buffer.concat([b, a])));
  assert.throws(() => new S.FrameReader(key, S.DIR_SERVER).feed(Buffer.concat([a, a])));
});

test('FrameReader: an absurd length is refused before reading the body', () => {
  const r = new S.FrameReader(Buffer.alloc(32), S.DIR_SERVER);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(S.MAX_PLAIN + 17);
  assert.throws(() => r.feed(head), /tamanho invalido/);
});

test('pairing codes: groups, case and bad input', () => {
  assert.equal(S.pairingSecret('0011-2233-4455-6677-8899-aabb-ccdd-eeff').toString('hex'),
    '00112233445566778899aabbccddeeff');
  assert.equal(S.pairingSecret('00112233445566778899AABBCCDDEEFF').toString('hex'),
    '00112233445566778899aabbccddeeff');
  assert.throws(() => S.pairingSecret('0011'), /32 caracteres/);
  assert.throws(() => S.pairingSecret('zz' + '0'.repeat(30)), /32 caracteres/);
  assert.throws(() => S.pairingSecret(''), /32 caracteres/);
});
