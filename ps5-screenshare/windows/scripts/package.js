/* Builds the Windows app: dist/PS5 Screen Share-win32-x64/PS5 Screen Share.exe
 *
 * Runs on Windows or Linux (Electron downloads the Windows runtime either way).
 *   npm install
 *   npm run dist
 */
'use strict';

const path = require('node:path');
const { packager } = require('@electron/packager');

const root = path.resolve(__dirname, '..');

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
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
