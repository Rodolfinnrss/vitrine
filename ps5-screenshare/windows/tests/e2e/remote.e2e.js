/* End-to-end test: the Windows app hosts the meeting server (acesso de fora de casa).
 *
 * Needs Playwright (dev dependency) and a display (on Linux: xvfb-run).
 * No PS5 is needed: the check is that the app listens when remote.json says
 * so, answers like the standalone relay, and frees the port when it closes.
 *
 *   xvfb-run -a npm run test:e2e:remote
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const electronPath = require('electron');
const { _electron: electron } = require('playwright');

const APP_DIR = path.resolve(__dirname, '..', '..');
const PORT = 19900 + Math.floor(Math.random() * 90);

let failures = 0;
function check(cond, msg) {
  console.log((cond ? '  ok   ' : '  FAIL ') + msg);
  if (!cond) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sends "SUB <id>" like an app would and returns the relay's one-line answer. */
function ask(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('SUB 0123456789abcdef\n'));
    let buf = '';
    s.setTimeout(3000, () => s.destroy());
    s.on('data', (c) => (buf += c.toString('ascii')));
    s.on('close', () => resolve(buf.trim()));
    s.on('error', () => resolve(null));
  });
}

async function waitFor(fn, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(250);
  }
  return false;
}

function launch(userData) {
  return electron.launch({
    executablePath: electronPath,
    args: [APP_DIR, '--no-sandbox', '--user-data-dir=' + userData],
    env: Object.assign({}, process.env, { ELECTRON_ENABLE_LOGGING: '' }),
  });
}

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ps5ss-remote-'));
  const remoteFile = path.join(userData, 'remote.json');

  // 1. Turned on: the app hosts the server and it closes with the app.
  fs.writeFileSync(remoteFile, JSON.stringify({ enabled: true, port: PORT }));
  let app = await launch(userData);
  try {
    await app.firstWindow();
    const up = await waitFor(async () => (await ask(PORT)) === 'NOCONSOLE', 15000);
    check(up, 'with remote.json enabled, the app answers on port ' + PORT + ' like the relay');
  } finally {
    await app.close();
  }
  await sleep(500);
  check((await ask(PORT)) === null, 'closing the app frees the port');
  check(JSON.parse(fs.readFileSync(remoteFile, 'utf8')).enabled === true, 'the setting is kept after closing');

  // 2. Turned off (default): nothing listens.
  fs.writeFileSync(remoteFile, JSON.stringify({ enabled: false, port: PORT }));
  app = await launch(userData);
  try {
    await app.firstWindow();
    await sleep(1500);
    check((await ask(PORT)) === null, 'with remote.json disabled, no port is opened');
  } finally {
    await app.close();
  }

  fs.rmSync(userData, { recursive: true, force: true });
  if (failures) {
    console.log(failures + ' check(s) failed');
    process.exit(1);
  }
  console.log('remote end-to-end checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
