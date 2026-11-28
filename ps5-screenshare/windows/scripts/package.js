/* Builds the Windows app: dist/PS5 Screen Share-win32-x64/PS5 Screen Share.exe
 *
 * Runs on Windows or Linux (Electron downloads the Windows runtime either way).
 *   npm install
 *   npm run dist
 */
'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { packager } = require('@electron/packager');
const { sync } = require('./sync-relay');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist');

sync(); // the app ships the same meeting server as relay/

packager({
  dir: root,
  out: path.join(root, 'dist'),
  name: 'PS5 Screen Share',
  platform: 'win32',
  arch: 'x64',
  overwrite: true,
  prune: true,
  asar: true,
  appCopyright: 'Copyright (C) 2026 PS5 Screen Share contributors - GPL-3.0-or-later',
  ignore: [
    /^\/tests(\/|$)/,
    /^\/scripts(\/|$)/,
    /^\/dist(\/|$)/,
    /^\/\.gitignore$/,
  ],
}).then((paths) => {
  for (const p of paths) console.log('pronto: ' + p);
  // One zip to copy to the PC: unpack it and run "PS5 Screen Share.exe".
  const zip = path.join(out, 'ps5-screenshare-windows.zip');
  const folder = path.basename(paths[0]);
  execFileSync('zip', ['-qr', zip, folder], { cwd: out, stdio: 'inherit' });
  console.log('pronto: ' + zip);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
