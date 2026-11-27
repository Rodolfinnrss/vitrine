/* End-to-end test: the real Electron app against the host build of the payload.
 *
 * Needs the host payload binary (payload: `make host`), Playwright (dev
 * dependency) and a display (on Linux: xvfb-run). The payload's mock capture
 * replays tests/fixtures/clip.h264, so no PS5 is needed.
 *
 *   PS5SS_HOST_BIN=../payload/build/host/ps5ss-service npm run test:e2e
 *
 * Checks: connect, picture reaches the canvas, a key press reaches the console
 * (/status shows the button), two keys held together, a rebound key, release,
 * and a clean disconnect.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const electronPath = require('electron');
const { _electron: electron } = require('playwright');

const APP_DIR = path.resolve(__dirname, '..', '..');
const BIN = path.resolve(process.env.PS5SS_HOST_BIN || path.join(APP_DIR, '..', 'payload', 'build', 'host', 'ps5ss-service'));
const CLIP = path.join(APP_DIR, 'tests', 'fixtures', 'clip.h264');
const PORT = 19800 + Math.floor(Math.random() * 100);

let failures = 0;
function check(cond, msg) {
  console.log((cond ? '  ok   ' : '  FAIL ') + msg);
  if (!cond) failures++;
}

/** The toolbar hides itself after a few idle seconds; moving the mouse shows it again. */
async function reveal(win) {
  await win.mouse.move(640, 300);
  await sleep(50);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

async function padStatus() {
  const r = await fetch('http://127.0.0.1:' + PORT + '/status');
  return (await r.json()).pad;
}

async function main() {
  if (!fs.existsSync(BIN)) {
    console.log('payload host binary not found at ' + BIN + ' (run `make host` in payload/)');
    process.exit(2);
  }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ps5ss-e2e-'));
  const payload = spawn(BIN, ['port=' + PORT, 'notify=0'], {
    env: Object.assign({}, process.env, {
      PS5SS_MOCK_H264: CLIP,
      PS5SS_DATA_DIR: path.join(userData, 'payload'),
      ASAN_OPTIONS: 'detect_leaks=0',
    }),
    stdio: 'ignore',
  });
  let app = null;
  try {
    await waitUntil(() => fetch('http://127.0.0.1:' + PORT + '/status').then((r) => r.ok).catch(() => false),
      10000, 'the payload');

    app = await electron.launch({
      executablePath: electronPath,
      args: [APP_DIR, '--no-sandbox', '--user-data-dir=' + userData],
      env: Object.assign({}, process.env, { ELECTRON_ENABLE_LOGGING: '' }),
    });
    const win = await app.firstWindow();
    await win.waitForSelector('#connect.active');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());

    console.log('connect screen');
    await win.fill('#host', '127.0.0.1');
    await win.fill('#port', String(PORT));
    await win.selectOption('#resolution', '720p');
    await win.click('#connect-btn');
    await win.waitForSelector('#player.active', { timeout: 10000 });
    check(true, 'connect switches to the player screen');

    console.log('picture');
    const drawn = await waitUntil(() => win.evaluate(() => {
      const c = document.getElementById('video');
      if (!c.width) return 0;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4 * 37) {
        if (d[i] + d[i + 1] + d[i + 2] > 120) lit++;
      }
      return lit;
    }), 15000, 'a picture');
    check(drawn > 50, 'the video is drawn on the canvas (' + drawn + ' lit samples)');

    console.log('controller');
    await waitUntil(async () => !(await padStatus()).owned, 3000, 'idle pad').catch(() => {});
    // Hold the key: a tap can be over before the status poll looks at it.
    await win.keyboard.down('KeyX');
    const pressed = await waitUntil(async () => (await padStatus()).buttons === '0x4000' || undefined,
      4000, 'cross').catch(() => null);
    check(!!pressed, 'holding X presses cross on the console');
    await win.keyboard.up('KeyX');
    let pad = await padStatus();
    await waitUntil(async () => (await padStatus()).buttons === '0x0' || undefined, 2000, 'release').catch(() => {});
    check((await padStatus()).buttons === '0x0', 'releasing X releases cross');
    pad = await padStatus();
    check(pad.available === 1, 'the console reports a virtual controller');

    await win.keyboard.down('ArrowUp');
    await win.keyboard.down('KeyX');
    await sleep(300);
    pad = await padStatus();
    check(pad.owned === 1, 'this app owns the controller while keys are held');
    check(Number.parseInt(pad.buttons, 16) === (0x4000 | 0x10), 'up and cross are both pressed');
    await win.keyboard.up('KeyX');
    await win.keyboard.up('ArrowUp');
    await sleep(300);
    pad = await padStatus();
    check(pad.buttons === '0x0', 'releasing the keys sends neutral (' + pad.buttons + ')');

    console.log('rebinding');
    await reveal(win);
    await win.click('#btn-keys-play');
    await win.waitForSelector('#keys-dialog[open]');
    await win.click('button[data-action="cross"]');
    await win.keyboard.press('KeyK');        // KeyK was right-stick down; they swap
    await win.click('#keys-save');
    await win.waitForSelector('#keys-dialog:not([open])', { state: 'attached' });
    await win.keyboard.down('KeyK');
    const crossNow = await waitUntil(async () => (await padStatus()).buttons === '0x4000' || undefined,
      4000, 'the rebound key K').catch(() => null);
    check(!!crossNow, 'holding the new key K presses cross');
    await win.keyboard.up('KeyK');
    await waitUntil(async () => (await padStatus()).buttons === '0x0' || undefined, 2000, 'release K').catch(() => {});
    await win.keyboard.down('KeyX');
    await sleep(400);
    check((await padStatus()).buttons === '0x0', 'X no longer presses cross (it moved to the right stick)');
    await win.keyboard.up('KeyX');

    console.log('disconnect');
    await reveal(win);
    await win.click('#btn-leave');
    await win.waitForSelector('#connect.active');
    const after = await waitUntil(async () => {
      const r = await fetch('http://127.0.0.1:' + PORT + '/status');
      const j = await r.json();
      return j.clients.length === 0 ? j : undefined;
    }, 4000, 'disconnect').catch(() => null);
    check(!!after, 'leaving the stream disconnects from the console');

    const saved = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
    check(saved.host === '127.0.0.1' && saved.bindings.cross === 'KeyK', 'settings (host and key binding) are saved');
  } finally {
    if (app) await app.close().catch(() => {});
    payload.kill();
    fs.rmSync(userData, { recursive: true, force: true });
  }
  console.log(failures ? failures + ' check(s) failed' : 'end-to-end checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
