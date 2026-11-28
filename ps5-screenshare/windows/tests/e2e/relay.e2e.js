/* End-to-end test of the relay path: the real Electron app, the real payload
 * (host build) and the real relay server, with no direct connection between
 * the app and the payload. Only the relay is reached.
 *
 *   PS5SS_HOST_BIN=../payload/build/host/ps5ss-service xvfb-run -a npm run test:e2e:relay
 *
 * Checks: the payload registers with the relay, the app connects through it by
 * pairing code, the picture arrives, a held key reaches the console, and a wrong
 * code gets no picture.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const electronPath = require('electron');
const { _electron: electron } = require('playwright');

const APP_DIR = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(APP_DIR, '..');
const BIN = path.resolve(process.env.PS5SS_HOST_BIN || path.join(REPO, 'payload', 'build', 'host', 'ps5ss-service'));
const RELAY = path.join(REPO, 'relay', 'server.js');
const CLIP = path.join(APP_DIR, 'tests', 'fixtures', 'clip.h264');
const PORT = 19900 + Math.floor(Math.random() * 50);
const RELAY_PORT = 19950 + Math.floor(Math.random() * 50);

let failures = 0;
function check(cond, msg) {
  console.log((cond ? '  ok   ' : '  FAIL ') + msg);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The toolbar hides itself after a few idle seconds; moving the mouse shows it again. */
async function reveal(win) {
  await win.mouse.move(640, 300);
  await sleep(50);
}

async function waitUntil(fn, ms, what) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timed out waiting for ' + what);
    await sleep(100);
  }
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port }, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
  });
}

async function status() {
  return (await fetch('http://127.0.0.1:' + PORT + '/status')).json();
}

async function main() {
  if (!fs.existsSync(BIN)) {
    console.log('payload host binary not found at ' + BIN + ' (run `make host` in payload/)');
    process.exit(2);
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ps5ss-relay-e2e-'));
  const dataDir = path.join(work, 'payload');
  const relay = spawn(process.execPath, [RELAY, String(RELAY_PORT)], { stdio: 'ignore' });
  const payload = spawn(BIN, ['port=' + PORT, 'notify=0', 'relay=127.0.0.1:' + RELAY_PORT], {
    env: Object.assign({}, process.env, {
      PS5SS_MOCK_H264: CLIP,
      PS5SS_DATA_DIR: dataDir,
      ASAN_OPTIONS: 'detect_leaks=0',
    }),
    stdio: 'ignore',
  });
  let app = null;
  try {
    await waitUntil(() => portOpen(RELAY_PORT), 10000, 'the relay');
    await waitUntil(() => status().then((s) => s.relay.connected === 1).catch(() => false), 15000,
      'the payload to register with the relay');
    const s = await status();
    check(s.relay.connected === 1, 'the payload registers with the relay (no direct route to the console)');

    // The host build writes its data under the directory it was compiled with.
    const code = fs.readFileSync(path.join(path.dirname(BIN), 'data', 'pairing.txt'), 'utf8').trim();
    check(code.replace(/-/g, '').length === 32, 'the console has a 128-bit pairing code');

    app = await electron.launch({
      executablePath: electronPath,
      args: [APP_DIR, '--no-sandbox', '--user-data-dir=' + path.join(work, 'app')],
    });
    const win = await app.firstWindow();
    await win.waitForSelector('#connect.active');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());

    console.log('connect through the relay');
    await win.check('input[name="mode"][value="relay"]', { timeout: 5000 });
    await win.fill('#relayHost', '127.0.0.1', { timeout: 5000 });
    await win.fill('#relayPort', String(RELAY_PORT), { timeout: 5000 });
    await win.fill('#pairCode', code, { timeout: 5000 });
    await win.selectOption('#resolution', '720p', { timeout: 5000 });
    await win.click('#connect-btn', { timeout: 5000 });
    await win.waitForSelector('#player.active', { timeout: 15000 });
    check(true, 'connect switches to the player screen');

    const drawn = await waitUntil(() => win.evaluate(() => {
      const c = document.getElementById('video');
      if (!c.width) return 0;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4 * 37) if (d[i] + d[i + 1] + d[i + 2] > 120) lit++;
      return lit;
    }), 20000, 'a picture through the relay');
    check(drawn > 50, 'the picture arrives through the relay (' + drawn + ' lit samples)');

    await win.keyboard.down('KeyX');
    const pressed = await waitUntil(async () => (await status()).pad.buttons === '0x4000' || undefined,
      5000, 'cross through the relay').catch(() => null);
    check(!!pressed, 'a key held in the app reaches the console through the relay');
    await win.keyboard.up('KeyX');
    await waitUntil(async () => (await status()).pad.buttons === '0x0' || undefined, 3000, 'release').catch(() => {});
    check((await status()).pad.buttons === '0x0', 'releasing the key releases the button on the console');

    console.log('wrong code');
    await reveal(win);
    await win.click('#btn-leave', { timeout: 5000 });
    await win.waitForSelector('#connect.active', { timeout: 5000 });
    await win.fill('#pairCode', '00000000000000000000000000000000');
    await win.click('#connect-btn', { noWaitAfter: true, timeout: 5000 });
    const refused = await waitUntil(() => win.evaluate(() => {
      const c = document.getElementById('connect');
      return c.classList.contains('active') && document.getElementById('connect-status').textContent.length > 0
        ? document.getElementById('connect-status').textContent : '';
    }), 15000, 'the connect screen to show the reason').catch(() => '');
    check(/não está conectado|pareamento|recusad|Conexão/i.test(refused),
      'a wrong code brings the app back to the connect screen with the reason (' + refused.slice(0, 70) + ')');
  } finally {
    if (app) await Promise.race([app.close().catch(() => {}), sleep(5000)]);
    payload.kill();
    relay.kill();
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log(failures ? failures + ' check(s) failed' : 'relay end-to-end checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
