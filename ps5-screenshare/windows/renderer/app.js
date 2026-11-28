/* PS5 Screen Share - screens, keyboard controller and status (renderer).
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
(function () {
  'use strict';

  const P = window.Ps5Protocol;
  const B = window.Ps5Bindings;
  const ps5 = window.ps5;
  const $ = (id) => document.getElementById(id);

  const els = {
    connect: $('connect'), player: $('player'),
    form: $('form'), host: $('host'), port: $('port'), resolution: $('resolution'),
    lanAddr: $('lan-addr'), relayAddr: $('relay-addr'), portField: $('port-field'),
    relayHost: $('relayHost'), relayPort: $('relayPort'), pairCode: $('pairCode'),
    fps: $('fps'), kbps: $('kbps'), audio: $('audio'), notice: $('notice'),
    connectBtn: $('connect-btn'), discoverBtn: $('discover-btn'), keysOpen: $('keys-open'),
    found: $('found'), status: $('connect-status'),
    video: $('video'), stats: $('stats'), message: $('message'),
    btnMute: $('btn-mute'), btnFill: $('btn-fill'), btnStats: $('btn-stats'),
    btnFull: $('btn-full'), btnKeysPlay: $('btn-keys-play'), btnLeave: $('btn-leave'),
    dialog: $('keys-dialog'), keysTable: $('keys-table').querySelector('tbody'),
    keysDefault: $('keys-default'), keysCancel: $('keys-cancel'), keysSave: $('keys-save'),
  };

  let settings = null;
  let pad = null;
  let padState = -1; // PAD_* from the console; -1 until it says
  let padSeq = 0;
  let padTimer = null;
  let video = null;
  let audio = null;
  let playing = false;
  let wantConnected = false;
  let sessionReady = false; // true once the console answered in the current session
  let reconnectTimer = null;
  let pingTimer = null;
  let statsTimer = null;
  let rtt = -1;
  let info = null;
  let draft = null;
  let capturing = null;
  let lastBytes = 0;
  let lastFrames = 0;
  let lastStatsAt = 0;
  let mbps = 0;
  let fpsNow = 0;
  let idleTimer = null;

  // ------------------------------------------------------------ helpers --

  function showNotice(text) {
    els.notice.textContent = text || '';
    els.notice.hidden = !text;
  }

  function currentMode() {
    const r = els.form.querySelector('input[name="mode"]:checked');
    return r && r.value === 'relay' ? 'relay' : 'lan';
  }

  /** Shows the fields for the chosen way of connecting. */
  function applyMode(mode) {
    const relay = mode === 'relay';
    const radio = els.form.querySelector('input[name="mode"][value="' + mode + '"]');
    if (radio) radio.checked = true;
    els.lanAddr.hidden = relay;
    els.relayAddr.hidden = !relay;
    els.portField.hidden = relay;
    els.discoverBtn.hidden = relay;
    if (relay) showNotice('');
    else checkAddress();
  }

  function checkAddress() {
    const host = els.host.value.trim();
    if (currentMode() === 'lan' && host && !P.isPrivateHost(host)) {
      showNotice('Este endereço não parece ser da sua rede. Para acessar de fora de casa, use uma VPN ' +
        'que leve até a sua rede. O PS5 não tem senha, então não exponha a porta na internet.');
    } else {
      showNotice('');
    }
  }

  function setStatus(text) {
    els.status.textContent = text || '';
  }

  let messageTimer = null;
  function setMessage(text, ms) {
    clearTimeout(messageTimer);
    if (!text) {
      els.message.hidden = true;
      return;
    }
    els.message.textContent = text;
    els.message.hidden = false;
    if (ms) messageTimer = setTimeout(() => { els.message.hidden = true; }, ms);
  }

  function sendLine(line) {
    ps5.send(line);
  }

  function padLabel() {
    if (!settings) return '';
    switch (padState) {
      case P.PAD.FREE: return 'controle: livre (aperte uma tecla para assumir)';
      case P.PAD.YOURS: return 'controle: com você';
      case P.PAD.BUSY: return 'controle: em uso por outro aparelho';
      case P.PAD.UNAVAILABLE: return 'controle: indisponível neste PS5';
      default: return 'controle: verificando…';
    }
  }

  // ------------------------------------------------------- connect screen --

  function showConnect(message) {
    playing = false;
    els.player.classList.remove('active');
    els.connect.classList.add('active');
    els.connectBtn.disabled = false;
    setStatus(message || '');
  }

  function showPlayer() {
    playing = true;
    els.connect.classList.remove('active');
    els.player.classList.add('active');
    els.connectBtn.disabled = false;
    wakeToolbar();
  }

  function readForm() {
    return {
      mode: currentMode(),
      host: els.host.value.trim(),
      port: Number(els.port.value) || 9700,
      relayHost: els.relayHost.value.trim(),
      relayPort: Number(els.relayPort.value) || 9800,
      pairCode: els.pairCode.value.trim(),
      resolution: els.resolution.value,
      fps: Number(els.fps.value),
      kbps: Number(els.kbps.value),
      audio: els.audio.checked,
    };
  }

  function fillForm(s) {
    els.host.value = s.host || '';
    els.port.value = s.port;
    els.relayHost.value = s.relayHost || '';
    els.relayPort.value = s.relayPort || 9800;
    els.pairCode.value = s.pairCode || '';
    applyMode(s.mode === 'relay' ? 'relay' : 'lan');
    els.resolution.value = s.resolution;
    els.fps.value = String(s.fps);
    els.kbps.value = String(s.kbps);
    els.audio.checked = s.audio;
    checkAddress();
  }

  async function discover() {
    els.discoverBtn.disabled = true;
    setStatus('Procurando PS5 na rede…');
    els.found.replaceChildren();
    try {
      const list = await ps5.discover();
      if (!list.length) {
        setStatus('Nenhum PS5 respondeu. Confira se o payload está rodando e se o PC está na mesma rede. ' +
          'Por VPN, digite o endereço.');
      } else {
        setStatus('Clique num console para usar o endereço dele.');
      }
      for (const c of list) {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = 'PS5 em ' + c.ip + ' · FW ' + c.firmware + ' · ' + c.clients + ' aparelho(s) conectado(s)';
        b.addEventListener('click', () => {
          els.host.value = c.ip;
          if (c.port) els.port.value = c.port;
          checkAddress();
        });
        li.appendChild(b);
        els.found.appendChild(li);
      }
    } finally {
      els.discoverBtn.disabled = false;
    }
  }

  async function connect(fromReconnect) {
    const form = readForm();
    if (form.mode === 'relay') {
      if (!form.relayHost) {
        setStatus('Informe o endereço do servidor de acesso.');
        return;
      }
      if (!form.pairCode) {
        setStatus('Informe o código de pareamento (está na página do PS5).');
        return;
      }
    } else if (!form.host) {
      setStatus('Informe o endereço do PS5.');
      return;
    }
    wantConnected = true;
    clearTimeout(reconnectTimer);
    if (!fromReconnect) {
      sessionReady = false;
      settings = Object.assign({}, settings, form);
      await ps5.saveSettings(settings);
      audio.start(); // inside a user gesture, so Chromium lets the sound play
      video.reset();
      info = null;
      rtt = -1;
      showPlayer();
      setMessage('Conectando a ' + form.host + '…');
    }
    els.connectBtn.disabled = true;
    const r = await ps5.connect(form);
    if (!r.ok) {
      wantConnected = false;
      showConnect(r.error);
      els.connectBtn.disabled = false;
      return;
    }
    if (!fromReconnect) setStatus('');
  }

  async function leave() {
    wantConnected = false;
    clearTimeout(reconnectTimer);
    if (pad && pad.releaseAll()) sendPadNow();
    stopPadTimer();
    stopTimers();
    await ps5.disconnect();
    showConnect('');
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (wantConnected) connect(true);
    }, 2000);
  }

  // ----------------------------------------------------- stream events --

  function onEvent(ev) {
    if (ev.kind === 'ready') {
      sessionReady = true;
      setMessage('Conectado. Aguardando o vídeo do PS5…');
      startTimers();
      return;
    }
    if (ev.kind === 'error') {
      setMessage('Erro: ' + ev.message, 0);
      return;
    }
    if (ev.kind === 'close') {
      stopTimers();
      padState = -1;
      video.reset();
      if (!wantConnected) return;
      if (!sessionReady) {
        // The first attempt failed (wrong code, console offline, ...): go back to the
        // connect screen with the reason, instead of retrying forever.
        wantConnected = false;
        showConnect(ev.message);
        return;
      }
      setMessage('Conexão perdida (' + ev.message + '). Tentando de novo…');
      scheduleReconnect();
    }
  }

  function onPacket(p) {
    switch (p.type) {
      case P.PKT.VIDEO:
        lastBytes += p.payload.length;
        video.push(p.payload, p.pts, (p.flags & P.FLAG_KEYFRAME) !== 0);
        break;
      case P.PKT.AUDIO:
        audio.push(p.payload);
        break;
      case P.PKT.INFO:
        try {
          info = JSON.parse(new TextDecoder().decode(p.payload));
        } catch (e) {
          info = null;
        }
        break;
      case P.PKT.STATUS:
        setMessage(new TextDecoder().decode(p.payload), 4000);
        break;
      case P.PKT.PONG:
        rtt = Date.now() - Number(new TextDecoder().decode(p.payload));
        break;
      case P.PKT.PAD:
        onPadAvailability(p.payload.length ? p.payload[0] : P.PAD.UNAVAILABLE);
        break;
      default:
        break;
    }
  }

  function onPadAvailability(state) {
    const before = padState;
    padState = state;
    if (state === P.PAD.BUSY && before !== P.PAD.BUSY) {
      setMessage('Este PS5 já está sendo controlado por outro aparelho.', 3000);
    }
    if (state === P.PAD.UNAVAILABLE && before !== P.PAD.UNAVAILABLE) {
      setMessage('O controle não está disponível neste PS5. Veja o log em http://IP-DO-PS5:9700/log.', 6000);
    }
    if (state === P.PAD.UNAVAILABLE) {
      if (pad.releaseAll()) sendPadNow();
    }
  }

  function startTimers() {
    stopTimers();
    pingTimer = setInterval(() => sendLine('PING ' + Date.now()), 1000);
    statsTimer = setInterval(updateStats, 1000);
    lastStatsAt = Date.now();
    lastFrames = video.rendered;
    lastBytes = 0;
    sendLine('KEY');
  }

  function stopTimers() {
    clearInterval(pingTimer);
    clearInterval(statsTimer);
    pingTimer = null;
    statsTimer = null;
  }

  function updateStats() {
    const now = Date.now();
    const secs = Math.max(1, now - lastStatsAt) / 1000;
    fpsNow = (video.rendered - lastFrames) / secs;
    mbps = (lastBytes * 8) / secs / 1e6;
    lastFrames = video.rendered;
    lastBytes = 0;
    lastStatsAt = now;
    if (!els.stats.hidden) {
      const head = info
        ? info.width + 'x' + info.height + '@' + info.fps + ' · FW ' + info.firmware
        : '…';
      els.stats.textContent = [
        head,
        fpsNow.toFixed(0) + ' fps · ' + mbps.toFixed(1) + ' Mbps · ping ' + (rtt >= 0 ? rtt + ' ms' : '-'),
        'quadros descartados: ' + (video.dropped + audio.dropped) + ' · erros de decodificação: ' + video.errors,
        padLabel(),
      ].join('\n');
    }
  }

  // ----------------------------------------------------------- keyboard --

  function sendPadNow() {
    if (padState < 0 || padState === P.PAD.UNAVAILABLE) return;
    padSeq = (padSeq + 1) >>> 0;
    sendLine(P.padLine(padSeq, pad.state()));
  }

  /** Called after any key changed the controller. Repeats the state every 50 ms while keys are held. */
  function onPadChanged() {
    sendPadNow();
    if (pad.anyHeld()) {
      if (!padTimer) padTimer = setInterval(sendPadNow, 50);
    } else {
      stopPadTimer();
    }
  }

  function stopPadTimer() {
    clearInterval(padTimer);
    padTimer = null;
  }

  function isTyping() {
    const a = document.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA');
  }

  window.addEventListener('keydown', (e) => {
    if (!playing || els.dialog.open || isTyping()) return;
    if (pad.actionFor(e.code)) {
      e.preventDefault();
      if (e.repeat) return;
      if (pad.press(e.code)) onPadChanged();
      return;
    }
    if (e.code === 'F11') {
      e.preventDefault();
      ps5.toggleFullscreen();
    }
  });

  window.addEventListener('keyup', (e) => {
    if (!playing || els.dialog.open) return;
    if (!pad.actionFor(e.code)) return;
    e.preventDefault();
    if (pad.release(e.code)) onPadChanged();
  });

  // A key released while another window had focus would stay pressed: let go of everything.
  window.addEventListener('blur', () => {
    if (pad && pad.releaseAll()) onPadChanged();
  });
  ps5.onBlur(() => {
    if (pad && pad.releaseAll()) onPadChanged();
  });

  // ---------------------------------------------------- settings dialog --

  function keyCell(action) {
    const td = document.createElement('td');
    td.className = 'key';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.action = action;
    btn.textContent = B.keyLabel(draft[action]);
    if (capturing === action) {
      btn.classList.add('capturing');
      btn.textContent = 'Pressione uma tecla…';
    }
    btn.addEventListener('click', () => {
      capturing = capturing === action ? null : action;
      renderKeys();
    });
    td.appendChild(btn);
    return td;
  }

  function renderKeys() {
    els.keysTable.replaceChildren();
    let group = '';
    for (const a of B.ACTIONS) {
      if (a.group !== group) {
        group = a.group;
        const tr = document.createElement('tr');
        tr.className = 'group';
        const td = document.createElement('td');
        td.colSpan = 2;
        td.textContent = group;
        tr.appendChild(td);
        els.keysTable.appendChild(tr);
      }
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = a.label;
      tr.appendChild(name);
      tr.appendChild(keyCell(a.id));
      els.keysTable.appendChild(tr);
    }
  }

  function onCaptureKey(e) {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') {
      capturing = null;
    } else if (e.code === 'Delete') {
      draft = B.withBinding(draft, capturing, null);
      capturing = null;
    } else if (!e.repeat) {
      draft = B.withBinding(draft, capturing, e.code);
      capturing = null;
    }
    renderKeys();
  }

  function openKeys() {
    // Keys held while the dialog opens would otherwise stay pressed on the console.
    if (pad.releaseAll()) onPadChanged();
    draft = Object.assign({}, settings.bindings);
    capturing = null;
    renderKeys();
    els.dialog.showModal();
    window.addEventListener('keydown', onCaptureKey, true);
  }

  function closeKeys() {
    capturing = null;
    window.removeEventListener('keydown', onCaptureKey, true);
    if (els.dialog.open) els.dialog.close();
  }

  async function saveKeys() {
    settings.bindings = B.sanitize(draft);
    pad.setBindings(settings.bindings);
    await ps5.saveSettings(settings);
    closeKeys();
    setStatus('Teclas salvas.');
  }

  // -------------------------------------------------------- player UI --

  function wakeToolbar() {
    els.player.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (playing) els.player.classList.add('idle');
    }, 3000);
  }

  function setFill(on) {
    els.player.classList.toggle('fill', on);
    els.btnFill.textContent = on ? 'Imagem: esticar' : 'Imagem: ajustar';
    if (settings) {
      settings.fill = on;
      ps5.saveSettings(settings);
    }
  }

  function setMute(on) {
    audio.setMuted(on);
    els.btnMute.textContent = on ? 'Som: mudo' : 'Som: ligado';
    if (settings) {
      settings.audio = !on;
      els.audio.checked = !on;
    }
  }

  // ---------------------------------------------------------- startup --

  function wire() {
    els.form.querySelectorAll('input[name="mode"]').forEach((r) => {
      r.addEventListener('change', () => applyMode(currentMode()));
    });
    els.host.addEventListener('input', checkAddress);
    els.form.addEventListener('submit', (e) => {
      e.preventDefault();
      connect(false);
    });
    els.discoverBtn.addEventListener('click', discover);
    els.keysOpen.addEventListener('click', openKeys);
    els.btnKeysPlay.addEventListener('click', openKeys);
    els.keysDefault.addEventListener('click', () => {
      draft = Object.assign({}, B.DEFAULT_BINDINGS);
      capturing = null;
      renderKeys();
    });
    els.keysCancel.addEventListener('click', closeKeys);
    els.keysSave.addEventListener('click', saveKeys);
    els.dialog.addEventListener('close', () => {
      capturing = null;
      window.removeEventListener('keydown', onCaptureKey, true);
    });
    els.btnLeave.addEventListener('click', leave);
    els.btnFull.addEventListener('click', () => ps5.toggleFullscreen());
    els.btnFill.addEventListener('click', () => setFill(!els.player.classList.contains('fill')));
    els.btnMute.addEventListener('click', () => setMute(!audio.muted));
    els.btnStats.addEventListener('click', () => {
      els.stats.hidden = !els.stats.hidden;
      if (!els.stats.hidden) updateStats();
    });
    els.player.addEventListener('mousemove', wakeToolbar);
    els.player.addEventListener('mousedown', wakeToolbar);
  }

  async function init() {
    settings = await ps5.loadSettings();
    pad = new B.PadInput(settings.bindings);
    video = new window.Ps5Video.VideoPlayer(els.video, {
      onNeedKey: () => sendLine('KEY'),
      onFirstFrame: () => setMessage(null),
    });
    audio = new window.Ps5Audio.AudioPlayer();
    audio.muted = !settings.audio;
    fillForm(settings);
    els.player.classList.toggle('fill', !!settings.fill);
    els.btnFill.textContent = settings.fill ? 'Imagem: esticar' : 'Imagem: ajustar';
    els.btnMute.textContent = settings.audio ? 'Som: ligado' : 'Som: mudo';
    if (!video.supported) {
      showConnect('Este PC não tem decodificador H.264 disponível. Atualize o Windows e o driver da placa de vídeo.');
    }
    ps5.onPacket(onPacket);
    ps5.onEvent(onEvent);
    wire();
    els.host.focus();
  }

  init();
})();
