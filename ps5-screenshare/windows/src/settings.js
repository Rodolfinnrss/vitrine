/* PS5 Screen Share - saved settings (Electron main process).
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Bindings = require('./bindings');
const Protocol = require('./protocol');

const RESOLUTIONS = ['720p', '1080p', '1440p', '2160p'];

function defaults() {
  return {
    mode: 'lan',              // 'lan' (same network) or 'relay' (from anywhere)
    host: '',
    port: Protocol.DEFAULT_PORT,
    relayHost: '',
    relayPort: 9800,
    pairCode: '',
    resolution: '1080p',
    fps: 60,
    kbps: 8000,
    audio: true,
    fill: false,
    bindings: Object.assign({}, Bindings.DEFAULT_BINDINGS),
  };
}

/** Clamps every field to something the console accepts; unknown fields are dropped. */
function normalize(input) {
  const d = defaults();
  const s = input && typeof input === 'object' ? input : {};
  const out = Object.assign({}, d);
  const host = typeof s.host === 'string' ? s.host.trim() : '';
  if (host.length <= 255 && /^[A-Za-z0-9.\-:]*$/.test(host)) out.host = host;
  const port = Number(s.port);
  if (Number.isInteger(port) && port >= 1 && port <= 65535) out.port = port;
  if (RESOLUTIONS.includes(s.resolution)) out.resolution = s.resolution;
  if (s.fps === 30 || s.fps === 60) out.fps = s.fps;
  const kbps = Number(s.kbps);
  if (Number.isInteger(kbps) && kbps >= 1000 && kbps <= 100000) out.kbps = kbps;
  if (typeof s.audio === 'boolean') out.audio = s.audio;
  if (typeof s.fill === 'boolean') out.fill = s.fill;
  if (s.mode === 'lan' || s.mode === 'relay') out.mode = s.mode;
  const relayHost = typeof s.relayHost === 'string' ? s.relayHost.trim() : '';
  if (relayHost.length <= 255 && /^[A-Za-z0-9.\-:]*$/.test(relayHost)) out.relayHost = relayHost;
  const relayPort = Number(s.relayPort);
  if (Number.isInteger(relayPort) && relayPort >= 1 && relayPort <= 65535) out.relayPort = relayPort;
  // Only the format is checked here; the pairing code is parsed when connecting.
  if (typeof s.pairCode === 'string' && s.pairCode.length <= 64) out.pairCode = s.pairCode.trim();
  out.bindings = Bindings.sanitize(s.bindings);
  return out;
}

function load(file) {
  try {
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    return defaults();
  }
}

/** Writes through a temporary file so a crash never leaves a half-written file. */
function save(file, settings) {
  const clean = normalize(settings);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return clean;
}

module.exports = { RESOLUTIONS, defaults, normalize, load, save };
