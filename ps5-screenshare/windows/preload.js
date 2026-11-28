/* PS5 Screen Share - the only bridge between the page and the main process.
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ps5', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  discover: () => ipcRenderer.invoke('discover'),
  connect: (opts) => ipcRenderer.invoke('stream:connect', opts),
  disconnect: () => ipcRenderer.invoke('stream:disconnect'),
  send: (line) => ipcRenderer.send('stream:send', line),
  toggleFullscreen: () => ipcRenderer.send('window:fullscreen'),
  onPacket: (cb) => {
    ipcRenderer.on('stream:packet', (_e, type, flags, pts, payload) => cb({ type, flags, pts, payload }));
  },
  onEvent: (cb) => {
    ipcRenderer.on('stream:event', (_e, ev) => cb(ev));
  },
  onBlur: (cb) => {
    ipcRenderer.on('app:blur', () => cb());
  },
});
