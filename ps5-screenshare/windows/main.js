/* PS5 Screen Share for Windows - Electron main process.
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Owns the TCP connection to the console. The window only sees parsed packets
 * and sends whitelisted command lines, so the page never opens sockets itself.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const Settings = require('./src/settings');
const Protocol = require('./src/protocol');
const { Ps5Connection } = require('./src/stream');
const { discover } = require('./src/discovery');
const Secure = require('./src/secure');
const RelayHost = require('./src/relay-host');

// Commands the page may send. Anything else is dropped here.
const ALLOWED_LINE = /^(PAD \d{1,10},\d{1,10},\d{1,3},\d{1,3},\d{1,3},\d{1,3},\d{1,3},\d{1,3}|PADRELEASE|PADSTATE|KEY|PING \d{1,16}|AUDIO [01]|SET [a-z0-9= ]{1,120})$/;

let win = null;
let conn = null;

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const remoteFile = () => path.join(app.getPath('userData'), 'remote.json');

/** Whether this PC hosts the meeting server (acesso de fora de casa). */
let remote = { enabled: false, port: RelayHost.DEFAULT_PORT };

function loadRemote() {
  try {
    const o = JSON.parse(fs.readFileSync(remoteFile(), 'utf8'));
    remote = {
      enabled: o.enabled === true,
      port: Number(o.port) > 0 && Number(o.port) < 65536 ? Number(o.port) : RelayHost.DEFAULT_PORT,
    };
  } catch (e) {
    // no file yet: keep the defaults
  }
}

function saveRemote() {
  try {
    fs.writeFileSync(remoteFile(), JSON.stringify(remote));
  } catch (e) {
    // the setting is still in memory for this run
  }
}

async function setRemoteEnabled(enabled) {
  if (enabled) {
    try {
      await RelayHost.start(remote.port);
      remote.enabled = true;
    } catch (err) {
      remote.enabled = false;
      const reason = err.code === 'EADDRINUSE'
        ? 'A porta ' + remote.port + ' ja esta em uso neste PC.'
        : 'Nao foi possivel ligar o acesso: ' + err.message;
      dialog.showErrorBox('PS5 Screen Share', reason);
    }
  } else {
    await RelayHost.stop();
    remote.enabled = false;
  }
  saveRemote();
  buildMenu();
}

function showAddresses() {
  const a = RelayHost.addresses();
  const running = RelayHost.isRunning();
  const port = running ? RelayHost.runningPort() : remote.port;
  const lines = [
    'Acesso de fora de casa: ' + (running ? 'ligado na porta ' + port : 'desligado'),
    '',
    'No config.ini do PS5 (pasta /data/ps5-screenshare):',
    '    relay=' + (a.lan[0] || 'IP-DESTE-PC') + ':' + port,
    '',
    'Nos apps de fora de casa, o endereco do servidor e:',
    '    ' + (a.vpn[0] || 'instale o Tailscale neste PC para ver o endereco 100.x') + ':' + port,
    '',
    'O codigo de pareamento aparece na pagina inicial do PS5 (http://IP-DO-PS5:9700).',
  ];
  dialog.showMessageBox(win || undefined, {
    type: 'info',
    title: 'PS5 Screen Share - endereços',
    message: 'Endereços do acesso de fora de casa',
    detail: lines.join('\n'),
    buttons: ['OK'],
  });
}

function buildMenu() {
  const template = [
    {
      label: 'Acesso de fora de casa',
      submenu: [
        {
          label: 'Hospedar acesso neste PC',
          type: 'checkbox',
          checked: remote.enabled,
          click: (item) => setRemoteEnabled(item.checked),
        },
        { label: 'Ver endereços', click: showAddresses },
        { type: 'separator' },
        { role: 'quit', label: 'Sair' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function toPage(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function dropConnection() {
  if (conn) {
    const c = conn;
    conn = null;
    c.close();
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 800,
    minHeight: 450,
    title: 'PS5 Screen Share',
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Keep decoding and key handling alive when another window has focus.
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('blur', () => toPage('app:blur'));
  win.on('closed', () => {
    win = null;
    dropConnection();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('settings:load', () => Settings.load(settingsFile()));
ipcMain.handle('settings:save', (_e, s) => Settings.save(settingsFile(), s));
ipcMain.handle('discover', () => discover());

ipcMain.handle('stream:connect', (_e, opts) => {
  const s = Settings.normalize(opts);
  const hello = Protocol.buildHello({ audio: s.audio, resolution: s.resolution, fps: s.fps, kbps: s.kbps });
  let target;
  if (s.mode === 'relay') {
    if (!s.relayHost) return { ok: false, error: 'Informe o endereço do servidor de acesso' };
    let secret;
    try {
      secret = Secure.pairingSecret(s.pairCode);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    target = { host: s.relayHost, port: s.relayPort, relaySecret: secret };
  } else {
    if (!s.host) return { ok: false, error: 'Informe o endereço do PS5' };
    target = { host: s.host, port: s.port };
  }
  dropConnection();
  const c = new Ps5Connection(Object.assign({ hello }, target)).connect();
  conn = c;
  c.on('ready', () => toPage('stream:event', { kind: 'ready' }));
  c.on('packet', (p) => toPage('stream:packet', p.type, p.flags, p.pts, p.payload));
  c.on('error', (err) => toPage('stream:event', { kind: 'error', message: err.message }));
  c.on('close', (reason) => {
    if (conn === c) conn = null;
    toPage('stream:event', { kind: 'close', message: reason });
  });
  return { ok: true };
});

ipcMain.handle('stream:disconnect', () => {
  dropConnection();
  return true;
});

ipcMain.on('stream:send', (_e, line) => {
  if (conn && typeof line === 'string' && ALLOWED_LINE.test(line)) conn.send(line);
});

ipcMain.on('window:fullscreen', () => {
  if (win) win.setFullScreen(!win.isFullScreen());
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    loadRemote();
    buildMenu();
    createWindow();
    if (remote.enabled) setRemoteEnabled(true);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    dropConnection();
    RelayHost.stop();
  });
}
