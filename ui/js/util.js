'use strict';
// ───────────── utilidades de DOM, ícones e formatação ─────────────

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.4 6.4L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15.4-6.4L21 8"/><path d="M21 3v5h-5"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  play: '<path d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.5-7.2a.8.8 0 0 0 0-1.4L8.2 4.1a.8.8 0 0 0-1.2.7z"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v5M14 11v5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  back: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  verified: '<path d="M12 2.8 14.3 4.5l2.9.1.9 2.7 2.3 1.8-.9 2.8.9 2.8-2.3 1.8-.9 2.7-2.9.1L12 21.2l-2.3-1.7-2.9-.1-.9-2.7-2.3-1.8.9-2.8-.9-2.8 2.3-1.8.9-2.7 2.9-.1z" fill="currentColor" stroke="none"/><path d="m8.6 12.2 2.3 2.3 4.6-4.8" stroke="#0b0d16" stroke-width="2.2"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h3.5"/>',
  terminal: '<rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="m7 9.5 3 2.5-3 2.5"/><path d="M12.5 15h4.5"/>',
  sparkle: '<path d="M12 3c.6 4.2 2.8 6.4 7 7-4.2.6-6.4 2.8-7 7-.6-4.2-2.8-6.4-7-7 4.2-.6 6.4-2.8 7-7z"/><path d="M19 15.5c.2 1.4.9 2.1 2.3 2.3-1.4.2-2.1.9-2.3 2.3-.2-1.4-.9-2.1-2.3-2.3 1.4-.2 2.1-.9 2.3-2.3z"/>',
  flame: '<path d="M12 21.5c3.9 0 6.5-2.6 6.5-6.2 0-2.9-1.8-5.2-3.3-6.7-.3 1.8-1.3 2.8-2.3 2.9.5-3-.9-6.3-3.8-8 .1 2.9-1.9 4.8-3.2 6.6-1 1.3-1.9 3-1.9 5.2 0 3.6 3.1 6.2 8 6.2z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z"/>',
  bug: '<rect x="7" y="8" width="10" height="12" rx="5"/><path d="M9.5 8V7a2.5 2.5 0 0 1 5 0v1"/><path d="M3 13h4M17 13h4M4.5 7.5 7 9.5M19.5 7.5 17 9.5M4.5 19l2.7-2M19.5 19l-2.7-2M12 12v8"/>',
  heart: '<path d="M12 20s-7.5-4.5-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.5 12 20 12 20z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.8"/><path d="M12 17.2h.01"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  music: '<path d="M9 18V5.5l11-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  cap: '<path d="M22 9.5 12 4.5 2 9.5l10 5z"/><path d="M6 11.5v4.8c3.5 2.3 8.5 2.3 12 0v-4.8"/><path d="M22 9.5v5"/>',
  gamepad: '<path d="M7.5 7h9a5 5 0 0 1 4.9 6l-.9 4.3a2.2 2.2 0 0 1-3.9.9L14.8 16H9.2l-1.8 2.2a2.2 2.2 0 0 1-3.9-.9L2.6 13A5 5 0 0 1 7.5 7z"/><path d="M8 10v3.5M6.25 11.75h3.5"/><path d="M15.5 11h.01M17.5 13h.01"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.6-.9 1.6-1.7 0-1.4-1.1-1.6-1.1-2.9 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5C21 6.4 17 3 12 3z"/><circle cx="7.5" cy="11.5" r="1" fill="currentColor"/><circle cx="10" cy="7.5" r="1" fill="currentColor"/><circle cx="15" cy="7.5" r="1" fill="currentColor"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M8.5 7V5.5A2 2 0 0 1 10.5 3.5h3a2 2 0 0 1 2 2V7"/><path d="M3 12.5h18"/>',
  flask: '<path d="M9 3h6"/><path d="M10 3v6.2L4.6 18.4A1.7 1.7 0 0 0 6.1 21h11.8a1.7 1.7 0 0 0 1.5-2.6L14 9.2V3"/><path d="M7.2 15h9.6"/>',
  cpu: '<rect x="5.5" y="5.5" width="13" height="13" rx="2.5"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3"/>',
  wrench: '<path d="M14.7 6.3a4.6 4.6 0 0 0 5.6 5.6l.2-.1-3-3 .9-2.6 2.6-.9 1 1-.1-.2a4.6 4.6 0 0 0-5.6-5.6 4.6 4.6 0 0 0-3.2 5.6L3.7 15.5a2.4 2.4 0 0 0 3.4 3.4L14.5 11.5"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.7 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.8 7.5-9.5V6z"/>',
  tag: '<path d="M3.5 12.3V4.5a1 1 0 0 1 1-1h7.8l8.6 8.6a1.5 1.5 0 0 1 0 2.1l-6.7 6.7a1.5 1.5 0 0 1-2.1 0z"/><circle cx="8" cy="8" r="1.5"/>',
  disk: '<path d="M4 14.5 6.6 6a2 2 0 0 1 1.9-1.4h7a2 2 0 0 1 1.9 1.4L20 14.5"/><rect x="3.5" y="14" width="17" height="6" rx="2"/><path d="M7.5 17h.01"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  zap: '<path d="M13 2.5 4.5 13.5H12l-1 8 8.5-11H12z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6h.01"/>',
  alert: '<path d="M10.3 4.1 2.6 17.5a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.1a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  maximize: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  chevDown: '<path d="m6 9 6 6 6-6"/>',
};

function icon(name, cls = '') {
  return `<svg class="i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

const CATEGORIES = [
  {id: 'AudioVideo', label: 'Áudio e Vídeo', icon: 'music', c1: '#ff6b6b', c2: '#ff9f43'},
  {id: 'Development', label: 'Desenvolvimento', icon: 'code', c1: '#3b82f6', c2: '#22d3ee'},
  {id: 'Education', label: 'Educação', icon: 'cap', c1: '#10b981', c2: '#a3e635'},
  {id: 'Game', label: 'Jogos', icon: 'gamepad', c1: '#ec4899', c2: '#f59e0b'},
  {id: 'Graphics', label: 'Gráficos e Fotos', icon: 'palette', c1: '#a855f7', c2: '#f472b6'},
  {id: 'Network', label: 'Internet', icon: 'globe', c1: '#06b6d4', c2: '#6366f1'},
  {id: 'Office', label: 'Produtividade', icon: 'briefcase', c1: '#f59e0b', c2: '#ef4444'},
  {id: 'Science', label: 'Ciência', icon: 'flask', c1: '#14b8a6', c2: '#8b5cf6'},
  {id: 'System', label: 'Sistema', icon: 'cpu', c1: '#6366f1', c2: '#8b5cf6'},
  {id: 'Utility', label: 'Utilitários', icon: 'wrench', c1: '#22c55e', c2: '#0ea5e9'},
];
const CAT = Object.fromEntries(CATEGORIES.map(c => [c.id.toLowerCase(), c]));
function catOf(name) {
  if (!name) return null;
  return CAT[String(name).toLowerCase()] || null;
}

const nfCompact = new Intl.NumberFormat('pt-BR', {notation: 'compact', maximumFractionDigits: 1});
const nf = new Intl.NumberFormat('pt-BR');
const rtf = new Intl.RelativeTimeFormat('pt-BR', {numeric: 'auto'});

const fmt = {
  compact: n => (n == null ? '—' : nfCompact.format(n)),
  num: n => (n == null ? '—' : nf.format(n)),
  bytes(b) {
    if (!b && b !== 0) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (b >= 1000 && i < u.length - 1) { b /= 1000; i++; }
    return `${b.toLocaleString('pt-BR', {maximumFractionDigits: b < 10 && i > 1 ? 1 : 0})} ${u[i]}`;
  },
  ago(ts) {
    if (!ts) return '—';
    const sec = Number(ts) * (String(ts).length > 11 ? 0.001 : 1);
    const diff = sec - Date.now() / 1000;
    const steps = [[60, 'second'], [3600, 'minute'], [86400, 'hour'], [86400 * 7, 'day'], [86400 * 30, 'week'], [86400 * 365, 'month'], [Infinity, 'year']];
    const div = {second: 1, minute: 60, hour: 3600, day: 86400, week: 86400 * 7, month: 86400 * 30, year: 86400 * 365};
    for (const [lim, unit] of steps) if (Math.abs(diff) < lim) return rtf.format(Math.round(diff / div[unit]), unit);
    return '—';
  },
  date(ts) {
    if (!ts) return '—';
    return new Date(Number(ts) * 1000).toLocaleDateString('pt-BR', {day: '2-digit', month: 'short', year: 'numeric'});
  },
};

function hashHue(str) {
  let x = 0;
  for (const ch of String(str)) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return x % 360;
}

function sanitizeHTML(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  const ok = new Set(['P', 'UL', 'OL', 'LI', 'EM', 'STRONG', 'B', 'I', 'CODE', 'BR']);
  const walk = node => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 1) {
        walk(child);
        if (!ok.has(child.tagName)) child.replaceWith(...child.childNodes);
        else for (const a of [...child.attributes]) child.removeAttribute(a.name);
      } else if (child.nodeType !== 3) child.remove();
    }
  };
  const root = doc.body.firstChild;
  walk(root);
  return root.innerHTML;
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const todayISO = () => new Date().toISOString().slice(0, 10);

// Cor dominante de um ícone (para brilhos e fundos tingidos)
const colorCache = new Map();
function dominantColor(url) {
  if (!url) return Promise.resolve(null);
  if (colorCache.has(url)) return colorCache.get(url);
  const p = new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 24;
        const x = c.getContext('2d', {willReadFrequently: true});
        x.drawImage(img, 0, 0, 24, 24);
        const d = x.getImageData(0, 0, 24, 24).data;
        let best = null, score = -1, r = 0, g = 0, b = 0, n = 0;
        const buckets = new Map();
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 160) continue;
          const R = d[i], G = d[i + 1], B = d[i + 2];
          const max = Math.max(R, G, B), min = Math.min(R, G, B);
          const sat = max === 0 ? 0 : (max - min) / max;
          r += R; g += G; b += B; n++;
          if (sat < 0.25 || max < 50) continue;
          const key = `${R >> 5},${G >> 5},${B >> 5}`;
          const e = buckets.get(key) || {R: 0, G: 0, B: 0, n: 0, sat: 0};
          e.R += R; e.G += G; e.B += B; e.n++; e.sat += sat;
          buckets.set(key, e);
        }
        for (const e of buckets.values()) {
          const s = e.n * (0.4 + e.sat / e.n);
          if (s > score) { score = s; best = e; }
        }
        if (best && best.n > 3) resolve([best.R / best.n, best.G / best.n, best.B / best.n].map(Math.round));
        else if (n) resolve([r / n, g / n, b / n].map(Math.round));
        else resolve(null);
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
  colorCache.set(url, p);
  return p;
}

function hexToRgb(hex) {
  const m = String(hex || '').match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// Clareia cores muito escuras para que funcionem como brilho no tema escuro
function liftColor([r, g, b], min = 110) {
  const max = Math.max(r, g, b);
  if (max >= min) return [r, g, b];
  if (max === 0) return [min, min, min];
  const k = min / max;
  return [r, g, b].map(v => Math.min(255, Math.round(v * k + 25)));
}
