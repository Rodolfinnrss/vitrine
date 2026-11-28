'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../src/settings');
const B = require('../src/bindings');

test('defaults are usable as they are', () => {
  const d = S.defaults();
  assert.equal(d.port, 9700);
  assert.equal(d.resolution, '1080p');
  assert.equal(d.fps, 60);
  assert.deepEqual(d.bindings, B.DEFAULT_BINDINGS);
});

test('normalize clamps and rejects bad values', () => {
  const s = S.normalize({ host: ' 192.168.0.10 ', port: 70000, resolution: '8k', fps: 45, kbps: 5,
    audio: 'yes', fill: true, bindings: { cross: 'KeyQ' }, extra: 1 });
  assert.equal(s.host, '192.168.0.10');
  assert.equal(s.port, 9700);
  assert.equal(s.resolution, '1080p');
  assert.equal(s.fps, 60);
  assert.equal(s.kbps, 8000);
  assert.equal(s.audio, true);
  assert.equal(s.fill, true);
  assert.equal(s.bindings.cross, 'KeyQ');
  assert.equal('extra' in s, false);
});

test('host with spaces or odd characters is cleared', () => {
  assert.equal(S.normalize({ host: 'evil.com/path' }).host, '');
  assert.equal(S.normalize({ host: 'a'.repeat(300) }).host, '');
});

test('save then load round-trips, and a missing file gives defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps5ss-settings-'));
  const file = path.join(dir, 'nested', 'settings.json');
  assert.deepEqual(S.load(file), S.defaults());
  const saved = S.save(file, { host: '10.0.0.5', resolution: '720p', fps: 30, kbps: 5000, audio: false });
  assert.equal(saved.host, '10.0.0.5');
  const back = S.load(file);
  assert.equal(back.resolution, '720p');
  assert.equal(back.fps, 30);
  assert.equal(back.audio, false);
  assert.equal(fs.existsSync(file + '.tmp'), false, 'no temporary file left behind');
});

test('a corrupt file falls back to defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps5ss-settings-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(S.load(file), S.defaults());
});
