'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../src/protocol');

function streamHeader() {
  return Buffer.from([0x50, 0x53, 0x35, 0x53, 0x00, 0x01, 0x00, 0x00]);
}

function packet(type, flags, pts, payload) {
  const h = Buffer.alloc(16);
  h[0] = type;
  h[1] = flags;
  h.writeUInt32BE(payload.length, 4);
  h.writeBigUInt64BE(BigInt(pts), 8);
  return Buffer.concat([h, Buffer.from(payload)]);
}

test('parser reads header and packets in one chunk', () => {
  const p = new P.StreamParser();
  const out = p.feed(Buffer.concat([streamHeader(), packet(P.PKT.PONG, 0, 42, Buffer.from('7'))]));
  assert.equal(out.length, 1);
  assert.equal(out[0].type, P.PKT.PONG);
  assert.equal(out[0].pts, 42);
  assert.equal(Buffer.from(out[0].payload).toString(), '7');
  assert.equal(p.headerDone, true);
});

test('parser copes with every possible split of the bytes', () => {
  const data = Buffer.concat([
    streamHeader(),
    packet(P.PKT.VIDEO, P.FLAG_KEYFRAME, 1000, Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3])),
    packet(P.PKT.AUDIO, 0, 2000, Buffer.alloc(4096, 7)),
    packet(P.PKT.PAD, 0, 3000, Buffer.from([2])),
  ]);
  for (let cut = 1; cut < data.length; cut += 7) {
    const p = new P.StreamParser();
    const got = [...p.feed(data.subarray(0, cut)), ...p.feed(data.subarray(cut))];
    assert.deepEqual(got.map((x) => x.type), [P.PKT.VIDEO, P.PKT.AUDIO, P.PKT.PAD], 'cut at ' + cut);
    assert.equal(got[0].flags, P.FLAG_KEYFRAME);
    assert.equal(got[1].payload.length, 4096);
    assert.equal(got[2].payload[0], 2);
  }
});

test('parser rejects other servers and wrong versions', () => {
  assert.throws(() => new P.StreamParser().feed(Buffer.from('HTTP/1.1 200 OK\r\n\r\n')), /nao e o PS5/);
  const v2 = streamHeader();
  v2[5] = 2;
  assert.throws(() => new P.StreamParser().feed(v2), /Versao de protocolo/);
});

test('parser rejects oversized packets', () => {
  const bad = Buffer.concat([streamHeader(), Buffer.alloc(16)]);
  bad.writeUInt32BE(P.MAX_PACKET + 1, 8 + 4);
  assert.throws(() => new P.StreamParser().feed(bad), /Pacote invalido/);
});

test('buildHello lists only the options that are set', () => {
  assert.equal(P.buildHello({ audio: true }), 'HELLO 1 audio=1');
  assert.equal(P.buildHello({ audio: false, resolution: '720p', fps: 30, kbps: 5000 }),
    'HELLO 1 audio=0 res=720p fps=30 bitrate=5000');
});

test('padLine uses the payload format and clamps values', () => {
  assert.equal(P.padLine(7, { buttons: 0x4000, lx: 128, ly: 128, rx: 128, ry: 128, l2: 0, r2: 0 }),
    'PAD 7,16384,128,128,128,128,0,0');
  assert.equal(P.padLine(4294967296 + 3, { buttons: 0, lx: 300, ly: -5, rx: 1, ry: 2, l2: 255, r2: 9 }),
    'PAD 3,0,255,0,1,2,255,9');
  assert.equal(P.padLine(1, {}), 'PAD 1,0,128,128,128,128,0,0');
});

test('discovery replies are parsed and foreign text is ignored', () => {
  const r = P.parseDiscoveryReply('PS5SS! {"app":"ps5-screenshare","port":9700,"ip":"192.168.0.10",' +
    '"firmware":"13.00","clients":1,"width":1920,"height":1080}');
  assert.equal(r.ip, '192.168.0.10');
  assert.equal(r.port, 9700);
  assert.equal(r.firmware, '13.00');
  assert.equal(r.clients, 1);
  assert.equal(P.parseDiscoveryReply('PS5SS? '), null);
  assert.equal(P.parseDiscoveryReply('PS5SS! {"app":"other"}'), null);
  assert.equal(P.parseDiscoveryReply('PS5SS! {nope'), null);
});

test('parameter sets and codec string come from a real stream', () => {
  const clip = fs.readFileSync(path.join(__dirname, 'fixtures', 'clip.h264'));
  // First access unit: find the first IDR and its leading SPS/PPS.
  const aus = splitAccessUnits(clip);
  const key = aus.find((au) => au.some((n) => (n[0] & 31) === 5));
  assert.ok(key, 'fixture has a keyframe');
  const annexB = Buffer.concat(key.flatMap((nal) => [Buffer.from([0, 0, 0, 1]), nal]));
  const ps = P.extractParameterSets(annexB);
  assert.ok(ps, 'SPS and PPS found');
  assert.equal(ps.sps[0] & 31, 7);
  assert.equal(ps.pps[0] & 31, 8);
  assert.equal(P.h264CodecFromSps(ps.sps), 'avc1.64000D');
  assert.equal(P.h264CodecFromSps(Buffer.from([0x67, 0x42])), null);
  assert.equal(P.h264CodecFromSps(Buffer.from([0x68, 0x42, 0, 0x1e])), null);
});

test('private addresses are recognised, public ones are flagged', () => {
  for (const h of ['192.168.0.10', '10.1.2.3', '172.16.5.5', '172.31.255.1', '100.100.1.1',
    '169.254.3.4', '127.0.0.1', 'ps5.local', 'localhost']) {
    assert.equal(P.isPrivateHost(h), true, h);
  }
  for (const h of ['8.8.8.8', '172.32.0.1', '200.1.2.3', 'meu-ps5.duckdns.org', '']) {
    assert.equal(P.isPrivateHost(h), false, h);
  }
});

/** Splits Annex-B into access units (lists of NAL payload Buffers, start codes removed). */
function splitAccessUnits(buf) {
  const starts = [];
  for (let i = 0; i + 3 <= buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) starts.push(i);
  }
  const nals = starts.map((s, k) => {
    let end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    while (end > s + 3 && buf[end - 1] === 0) end--;
    return buf.subarray(s + 3, end);
  });
  const aus = [];
  let cur = [];
  for (const n of nals) {
    if ((n[0] & 31) === 9 && cur.length) {
      aus.push(cur);
      cur = [];
    }
    cur.push(n);
  }
  if (cur.length) aus.push(cur);
  return aus;
}
