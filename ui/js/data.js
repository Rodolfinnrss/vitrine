'use strict';
// ───────────── ponte com o processo nativo, API do Flathub e estado ─────────────

const Bridge = (() => {
  const host = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.vitrine;
  const pending = new Map();
  const listeners = new Set();
  let seq = 0;

  function dispatch(msg) {
    if (msg.type === 'reply') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error));
    } else {
      for (const fn of listeners) {
        try { fn(msg); } catch (e) { console.error(e); }
      }
    }
  }
  window.__vitrine = {receive: dispatch};

  function call(cmd, args = {}) {
    if (!host) return Mock.call(cmd, args, dispatch);
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, {resolve, reject});
      host.postMessage(JSON.stringify({id, cmd, args}));
    });
  }

  return {call, on: fn => listeners.add(fn), native: !!host};
})();

// Simulação usada quando a interface é aberta fora do app nativo (num navegador comum).
const Mock = {
  installed: new Map(),
  ops: new Map(),
  seq: 0,
  async call(cmd, args, dispatch) {
    await sleep(60);
    switch (cmd) {
    case 'env': return {flatpak: !/noflatpak/.test(location.search), version: '1.16.1 (simulado)', arch: 'x86_64', remotes: {user: 'flathub', system: null}};
    case 'installed': return [...this.installed.values()];
    case 'updates': return [];
    case 'config:get': try { return JSON.parse(localStorage.getItem('vitrine.config') || '{}'); } catch { return {}; }
    case 'config:set': try { localStorage.setItem('vitrine.config', JSON.stringify(args)); } catch {} return true;
    case 'copy': try { await navigator.clipboard.writeText(args.text); } catch {} return true;
    case 'open': window.open(args.url, '_blank'); return true;
    case 'launch': return true;
    case 'cancel': { const op = this.ops.get(args.opId); if (op) op.cancel = true; return true; }
    case 'clear-ops': return true;
    case 'install': case 'uninstall': case 'update': case 'setup': {
      const op = {opId: `m${++this.seq}`, kind: cmd, appId: args.id || null, name: args.name || args.id, icon: args.icon, scope: args.scope || 'user',
        status: 'running', progress: 0, phase: 'Preparando…', cmd: cmd === 'setup' ? 'pkexec apt-get install -y flatpak' : `flatpak ${cmd} -y --${args.scope || 'user'} ${cmd === 'install' ? 'flathub ' : ''}${args.id || ''}`, tail: '', error: null};
      this.ops.set(op.opId, op);
      const lines = [`$ ${op.cmd}`, 'Looking for matches…'];
      const total = cmd === 'install' ? 3 : 1;
      (async () => {
        dispatch({type: 'op', op: {...op}});
        for (let step = 1; step <= total; step++) {
          for (let p = 0; p <= 100; p += 4 + Math.round(Math.random() * 6)) {
            if (op.cancel) { op.status = 'cancelled'; op.phase = 'Cancelado'; dispatch({type: 'op', op: {...op}}); return; }
            op.progress = ((step - 1) + p / 100) / total;
            op.phase = total > 1 ? `${cmd === 'install' ? 'Instalando' : 'Atualizando'} ${step} de ${total}` : (cmd === 'uninstall' ? 'Removendo' : 'Atualizando');
            op.tail = [...lines, `${cmd === 'uninstall' ? 'Uninstalling' : 'Installing'} ${step}/${total}… ${'█'.repeat(p / 5)}${' '.repeat(20 - p / 5)} ${p}%  3.4 MB/s`].join('\n');
            dispatch({type: 'op', op: {...op}});
            await sleep(70);
          }
          lines.push(`Installing ${step}/${total}… ${'█'.repeat(20)} 100%`);
        }
        op.status = 'done'; op.progress = 1; op.phase = 'Concluído';
        op.tail = [...lines, cmd === 'uninstall' ? 'Uninstall complete.' : 'Installation complete.'].join('\n');
        if (cmd === 'install') this.installed.set(op.appId, {id: op.appId, name: op.name, version: '1.0', installation: op.scope, origin: 'flathub'});
        if (cmd === 'uninstall') this.installed.delete(op.appId);
        dispatch({type: 'op', op: {...op}});
        dispatch({type: 'installed-changed', kind: cmd});
      })();
      return {...op};
    }
    case 'http': return (await fetch(args.url, {method: args.method, headers: {'content-type': 'application/json'}, body: args.body})).text();
    }
    throw new Error(`mock: comando desconhecido ${cmd}`);
  },
};

// ───────────── API do Flathub ─────────────

const API = 'https://flathub.org/api/v2';
const LOCALE = (navigator.language || 'pt-BR').replace('-', '_');
const memo = new Map();

function cached(key, make) {
  if (memo.has(key)) return memo.get(key);
  const p = make();
  memo.set(key, p);
  p.catch(() => memo.delete(key));
  return p;
}

async function fetchJSON(url, init) {
  try {
    const r = await fetch(url, init);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (!Bridge.native) throw e;
    // Alternativa: deixa o processo nativo fazer a requisição (sem CORS)
    const text = await Bridge.call('http', {method: init?.method || 'GET', url, body: init?.body});
    return JSON.parse(text);
  }
}

const Api = {
  collection: (name, page = 1, per = 36) => cached(`c:${name}:${page}:${per}`, () => fetchJSON(`${API}/collection/${name}?page=${page}&per_page=${per}&locale=${LOCALE}`)),
  category: (cat, page = 1, per = 36) => cached(`cat:${cat}:${page}:${per}`, () => fetchJSON(`${API}/collection/category/${cat}?page=${page}&per_page=${per}&locale=${LOCALE}`)),
  search: (q, page = 1, per = 36) => cached(`s:${q}:${page}:${per}`, () => fetchJSON(`${API}/search?locale=${LOCALE}`, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({query: q, hits_per_page: per, page}),
  })),
  details: id => cached(`d:${id}`, () => fetchJSON(`${API}/appstream/${encodeURIComponent(id)}?locale=${LOCALE}`)),
  summary: id => cached(`sum:${id}`, () => fetchJSON(`${API}/summary/${encodeURIComponent(id)}`)),
  stats: id => cached(`st:${id}`, () => fetchJSON(`${API}/stats/${encodeURIComponent(id)}`)),
  appOfDay: date => cached(`aod:${date}`, () => fetchJSON(`${API}/app-picks/app-of-the-day/${date}`)),
  appsOfWeek: date => cached(`aow:${date}`, () => fetchJSON(`${API}/app-picks/apps-of-the-week/${date}`)),
};

// Normaliza um app vindo da busca/coleções ou dos detalhes num formato único
function normApp(x) {
  if (!x) return null;
  if (x.__norm) return x;
  const id = x.app_id || x.id;
  const isDetails = Array.isArray(x.screenshots) || Array.isArray(x.icons);
  let icon = x.icon || null;
  if (isDetails && Array.isArray(x.icons) && x.icons.length) {
    const sorted = [...x.icons].sort((a, b) => (b.width * (b.scale || 1)) - (a.width * (a.scale || 1)));
    icon = x.icon || sorted[sorted.length - 1].url;
  }
  const brand = Array.isArray(x.branding)
    ? (x.branding.find(b => b.type === 'primary' && b.scheme_preference === 'dark') || x.branding.find(b => b.type === 'primary'))
    : null;
  const mainCat = x.main_categories || (Array.isArray(x.categories) ? x.categories.find(c => catOf(c)) : null);
  const app = {
    __norm: true,
    id,
    name: x.name || id,
    summary: x.summary || '',
    icon,
    developer: x.developer_name || '',
    verified: !!x.verification_verified || !!(x.metadata && x.metadata['flathub::verification::verified'] === 'true'),
    installs: x.installs_last_month ?? null,
    category: mainCat ? String(mainCat) : null,
    brand: brand ? brand.value : null,
    updated: x.updated_at || null,
  };
  const prev = S.apps.get(id);
  S.apps.set(id, prev ? {...prev, ...Object.fromEntries(Object.entries(app).filter(([, v]) => v != null && v !== ''))} : app);
  return S.apps.get(id);
}

function pickShot(shot, want = 752) {
  if (!shot || !Array.isArray(shot.sizes) || !shot.sizes.length) return null;
  const sizes = [...shot.sizes].map(s => ({...s, w: Number(s.width) || 0})).sort((a, b) => a.w - b.w);
  return (sizes.find(s => s.w >= want) || sizes[sizes.length - 1]).src;
}

// ───────────── estado global ─────────────

const S = {
  env: {flatpak: null, remotes: {}},
  config: {scope: 'user', motion: true},
  installed: new Map(),
  updates: new Map(),
  ops: new Map(),
  apps: new Map(),
};

const Events = new EventTarget();
const emitState = (name, detail) => Events.dispatchEvent(new CustomEvent(name, {detail}));

function activeOpFor(appId) {
  let found = null;
  for (const op of S.ops.values()) {
    if (op.appId !== appId) continue;
    if (op.status === 'running') return op;
    if (op.status === 'queued') found = found || op;
  }
  return found;
}

async function saveConfig() {
  try { await Bridge.call('config:set', S.config); } catch {}
}

async function refreshEnv() {
  try { S.env = await Bridge.call('env'); } catch { S.env = {flatpak: false, remotes: {}}; }
  emitState('env');
  await refreshInstalled();
  refreshUpdates();
}

async function refreshInstalled() {
  try {
    const list = await Bridge.call('installed');
    S.installed = new Map(list.map(a => [a.id, a]));
  } catch {}
  emitState('installed');
}

async function refreshUpdates() {
  if (!S.env.flatpak) return;
  try {
    const list = await Bridge.call('updates');
    S.updates = new Map(list.map(a => [a.id, a]));
  } catch {}
  emitState('updates');
}
