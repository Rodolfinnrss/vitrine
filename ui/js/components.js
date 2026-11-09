'use strict';
// ───────────── componentes: ícones de app, botões de ação, cards, prateleiras… ─────────────

function appIcon(app, cls = '') {
  if (app.icon) return `<img class="app-icon ${cls}" data-tint src="${esc(app.icon)}" alt="" loading="lazy" decoding="async" draggable="false">`;
  return avatarHTML(app, cls);
}
function avatarHTML(app, cls = '') {
  return `<div class="app-icon avatar ${cls}" style="--h:${hashHue(app.id)}">${esc(String(app.name || app.id || '?').trim()[0] || '?')}</div>`;
}

// Fade-in de imagens + cor dominante para os brilhos dos cards
document.addEventListener('load', e => {
  const img = e.target;
  if (img.tagName !== 'IMG') return;
  img.classList.add('ok');
  if (!img.hasAttribute('data-tint')) return;
  const host = img.closest('[data-glow]');
  if (!host) return;
  const key = img.currentSrc || img.src;
  let p = colorCache.get(key);
  if (!p) {
    p = Promise.resolve().then(() => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 20;
        const x = c.getContext('2d', {willReadFrequently: true});
        x.drawImage(img, 0, 0, 20, 20);
        return pickColor(x.getImageData(0, 0, 20, 20).data);
      } catch { return null; }
    });
    colorCache.set(key, p);
  }
  p.then(rgb => { if (rgb) host.style.setProperty('--glow', liftColor(rgb, 140).join(',')); });
}, true);

document.addEventListener('error', e => {
  const img = e.target;
  if (img.tagName !== 'IMG' || !img.classList.contains('app-icon')) return;
  const holder = document.createElement('div');
  const card = img.closest('[data-app]');
  const id = card ? card.dataset.app : img.src;
  holder.innerHTML = avatarHTML(S.apps.get(id) || {id, name: '?'}, img.className.replace('app-icon', ''));
  img.replaceWith(holder.firstChild);
}, true);

function pickColor(d) {
  const buckets = new Map();
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 160) continue;
    const R = d[i], G = d[i + 1], B = d[i + 2];
    const max = Math.max(R, G, B), min = Math.min(R, G, B);
    r += R; g += G; b += B; n++;
    const sat = max ? (max - min) / max : 0;
    if (sat < 0.28 || max < 60) continue;
    const key = `${R >> 5},${G >> 5},${B >> 5}`;
    const e = buckets.get(key) || {R: 0, G: 0, B: 0, n: 0, s: 0};
    e.R += R; e.G += G; e.B += B; e.n++; e.s += sat;
    buckets.set(key, e);
  }
  let best = null, score = -1;
  for (const e of buckets.values()) {
    const sc = e.n * (0.5 + e.s / e.n);
    if (sc > score) { score = sc; best = e; }
  }
  if (best && best.n >= 3) return [best.R / best.n, best.G / best.n, best.B / best.n].map(Math.round);
  return n ? [r / n, g / n, b / n].map(Math.round) : null;
}

// ───────────── botão de ação (Instalar / progresso / Abrir / Remover) ─────────────

function actionButton(app, variant = 'mini') {
  const el = h('div', {class: `act act-${variant}`, 'data-act': app.id});
  el._app = app;
  renderAct(el);
  return el;
}

function actState(id) {
  const op = activeOpFor(id);
  if (op) return {state: op.status === 'queued' ? 'queued' : 'busy', op};
  if (S.installed.has(id)) return {state: S.updates.has(id) ? 'update' : 'installed'};
  return {state: 'idle'};
}

const RING = 2 * Math.PI * 15.5;

function renderAct(el, {pop = false} = {}) {
  const id = el.dataset.act;
  const app = el._app || S.apps.get(id) || {id, name: id};
  const {state, op} = actState(id);
  const mini = el.classList.contains('act-mini');
  if (el.dataset.state === state && (state === 'busy' || state === 'queued')) {
    updateBusy(el, op, mini);
    return;
  }
  const prev = el.dataset.state;
  el.dataset.state = state;
  el.classList.toggle('act-pop', pop || (prev === 'busy' && (state === 'installed' || state === 'idle')));

  if (mini) {
    if (state === 'idle') el.innerHTML = `<button class="pill pill-get" data-do="install"><span>Instalar</span></button>`;
    else if (state === 'installed') el.innerHTML = `<button class="pill pill-open" data-do="open">${icon('play')}<span>Abrir</span></button>`;
    else if (state === 'update') el.innerHTML = `<button class="pill pill-upd" data-do="update">${icon('refresh')}<span>Atualizar</span></button>`;
    else {
      el.innerHTML = `<button class="ring ${state === 'queued' ? 'ring-wait' : ''}" data-do="cancel" title="Cancelar">
        <svg viewBox="0 0 36 36"><circle class="ring-bg" cx="18" cy="18" r="15.5"/><circle class="ring-fg" cx="18" cy="18" r="15.5" stroke-dasharray="${RING}" stroke-dashoffset="${RING}"/></svg>
        <span class="ring-pct"></span><span class="ring-x">${icon('x')}</span></button>`;
      updateBusy(el, op, true);
    }
  } else {
    const inst = S.installed.get(id);
    if (state === 'idle') {
      el.innerHTML = `<button class="btn btn-primary btn-lg" data-do="install">${icon('download')}<span>Instalar</span><i class="sheen"></i></button>`;
    } else if (state === 'installed' || state === 'update') {
      el.innerHTML = `${state === 'update' ? `<button class="btn btn-primary btn-lg" data-do="update">${icon('refresh')}<span>Atualizar</span><i class="sheen"></i></button>` : ''}
        <button class="btn ${state === 'update' ? 'btn-ghost' : 'btn-primary btn-ok'} btn-lg" data-do="open">${icon('play')}<span>Abrir</span>${state === 'update' ? '' : '<i class="sheen"></i>'}</button>
        <button class="btn btn-ghost btn-lg btn-icon btn-danger" data-do="remove" title="Remover">${icon('trash')}</button>
        ${inst ? `<span class="scope-tag">${inst.installation === 'system' ? 'Sistema' : 'Usuário'}${inst.version ? ` · v${esc(inst.version)}` : ''}</span>` : ''}`;
    } else {
      el.innerHTML = `<div class="bprog ${state === 'queued' ? 'bprog-wait' : ''}">
          <div class="bprog-fill"></div><div class="bprog-shine"></div>
          <div class="bprog-label"><span class="bprog-phase"></span><b class="bprog-pct"></b></div>
        </div>
        <button class="btn btn-ghost btn-lg btn-icon" data-do="cancel" title="Cancelar">${icon('x')}</button>`;
      updateBusy(el, op, false);
    }
  }
  el._app = app;
}

function updateBusy(el, op, mini) {
  const p = op && op.progress != null ? op.progress : null;
  const indeterminate = p == null || op.status === 'queued';
  if (mini) {
    const ring = $('.ring', el);
    if (!ring) return;
    ring.classList.toggle('ring-spin', indeterminate);
    const fg = $('.ring-fg', el);
    fg.style.strokeDashoffset = indeterminate ? RING * 0.72 : RING * (1 - p);
    $('.ring-pct', el).textContent = indeterminate ? '' : Math.floor(p * 100);
  } else {
    const bar = $('.bprog', el);
    if (!bar) return;
    bar.classList.toggle('bprog-indet', indeterminate);
    bar.style.setProperty('--p', indeterminate ? 0 : p);
    $('.bprog-phase', el).textContent = op.status === 'queued' ? 'Na fila…' : (op.phase || 'Trabalhando…');
    $('.bprog-pct', el).textContent = indeterminate ? '' : `${Math.floor(p * 100)}%`;
  }
}

function refreshActs(id, opts) {
  const sel = id ? `[data-act="${CSS.escape(id)}"]` : '[data-act]';
  $$(sel).forEach(el => renderAct(el, opts));
}

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-do]');
  if (!btn) return;
  const act = btn.closest('[data-act]');
  if (!act) return;
  e.stopPropagation();
  e.preventDefault();
  const id = act.dataset.act;
  const app = act._app || S.apps.get(id) || {id, name: id};
  Actions[btn.dataset.do]?.(app, btn);
}, true);

const Actions = {
  async install(app, btn) {
    if (!S.env.flatpak) return openSetupModal(app);
    try {
      const op = await Bridge.call('install', {id: app.id, scope: S.config.scope, name: app.name, icon: app.icon});
      onOp(op);
    } catch (e) { toast(e.message, {tone: 'bad', ic: 'alert'}); }
  },
  async open(app) {
    try {
      await Bridge.call('launch', {id: app.id});
      toast(`Abrindo ${app.name}…`, {img: app.icon, ic: 'play'});
    } catch (e) { toast(e.message, {tone: 'bad', ic: 'alert'}); }
  },
  async remove(app) {
    const inst = S.installed.get(app.id);
    const ok = await confirmDialog({
      title: `Remover ${app.name}?`,
      text: 'O aplicativo será desinstalado. Seus arquivos pessoais não são apagados.',
      cmd: `flatpak uninstall -y --${inst?.installation || 'user'} ${app.id}`,
      confirm: 'Remover', danger: true, img: app.icon,
    });
    if (!ok) return;
    try {
      onOp(await Bridge.call('uninstall', {id: app.id, scope: inst?.installation || 'user', name: app.name, icon: app.icon}));
    } catch (e) { toast(e.message, {tone: 'bad', ic: 'alert'}); }
  },
  async update(app) {
    const inst = S.installed.get(app.id);
    try {
      onOp(await Bridge.call('update', {id: app.id, scope: inst?.installation || 'user', name: app.name, icon: app.icon}));
    } catch (e) { toast(e.message, {tone: 'bad', ic: 'alert'}); }
  },
  async cancel(app) {
    const op = activeOpFor(app.id);
    if (op) await Bridge.call('cancel', {opId: op.opId});
  },
};

// ───────────── eventos de operações vindos do processo nativo ─────────────

function onOp(op) {
  if (!op || !op.opId) return;
  const prev = S.ops.get(op.opId);
  if (op.icon == null && op.appId) op.icon = S.apps.get(op.appId)?.icon || null;
  S.ops.set(op.opId, {...prev, ...op});
  if (op.appId) refreshActs(op.appId);
  Dock.update();
  const finished = prev && prev.status !== op.status && ['done', 'error', 'cancelled'].includes(op.status);
  if (!finished) return;
  const name = op.name || op.appId;
  if (op.status === 'done') {
    const msg = {install: `${name} foi instalado`, uninstall: `${name} foi removido`, update: `${name} foi atualizado`, setup: 'Flatpak configurado com sucesso'}[op.kind];
    toast(msg, {img: op.icon, ic: 'check'});
    if (op.kind === 'install' || op.kind === 'update' || op.kind === 'setup') {
      const target = op.appId && $$(`[data-act="${CSS.escape(op.appId)}"]`).find(el => el.getBoundingClientRect().width > 0);
      if (target) burst(target);
    }
  } else if (op.status === 'error') {
    toast(`${name}: ${op.error || 'falhou'}`, {tone: 'bad', ic: 'alert', ms: 6000});
  }
}

Bridge.on(msg => {
  if (msg.type === 'op') onOp(msg.op);
  else if (msg.type === 'installed-changed') refreshInstalled().then(() => { if (msg.kind === 'update') refreshUpdates(); });
  else if (msg.type === 'env-changed') refreshEnv();
});

Events.addEventListener('installed', () => refreshActs());
Events.addEventListener('updates', () => refreshActs());

// ───────────── cards ─────────────

function appCard(raw, i = 0) {
  const app = normApp(raw);
  const cat = catOf(app.category);
  const card = h('article', {class: 'card', style: `--i:${i % 18}`, tabindex: '0', 'data-app': app.id, 'data-glow': ''});
  card.innerHTML = `
    <div class="card-spot"></div>
    <div class="card-icon">${appIcon(app)}</div>
    <div class="card-body">
      <h3 class="card-title"><span>${esc(app.name)}</span>${app.verified ? `<span class="verified" title="Desenvolvedor verificado">${icon('verified')}</span>` : ''}</h3>
      <p class="card-sum">${esc(app.summary)}</p>
      <div class="card-meta">
        ${app.installs ? `<span title="Instalações no último mês">${icon('download')}${fmt.compact(app.installs)}</span>` : ''}
        ${cat ? `<span class="cat-dot" style="--c1:${cat.c1};--c2:${cat.c2}">${cat.label}</span>` : ''}
      </div>
    </div>`;
  card.append(actionButton(app, 'mini'));
  const open = () => openApp(app, $('.app-icon', card));
  card.addEventListener('click', open);
  card.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
  return card;
}

function shotCard(details, i = 0) {
  const app = normApp(details);
  const shot = pickShot(details.screenshots?.[0], 624);
  const card = h('article', {class: 'shot-card', style: `--i:${i}`, tabindex: '0', 'data-app': app.id, 'data-glow': ''});
  card.innerHTML = `
    <div class="shot-media">${shot ? `<img src="${esc(shot)}" alt="" loading="lazy" decoding="async" draggable="false">` : ''}<div class="shot-fade"></div></div>
    <div class="shot-info">
      <div class="shot-icon">${appIcon(app)}</div>
      <div class="shot-text"><h3>${esc(app.name)}${app.verified ? `<span class="verified">${icon('verified')}</span>` : ''}</h3><p>${esc(app.summary)}</p></div>
    </div>`;
  card.append(actionButton(app, 'mini'));
  const open = () => openApp(app, $('.app-icon', card));
  card.addEventListener('click', open);
  card.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
  return card;
}

function skelCard(i = 0) {
  return h('div', {class: 'card skel', style: `--i:${i}`, html: '<div class="sk sk-icon"></div><div class="sk-lines"><i></i><i></i><i class="short"></i></div>'});
}

// Brilho que segue o mouse
document.addEventListener('pointermove', e => {
  const card = e.target.closest?.('.card, .shot-card, .cat-tile, .glow-follow');
  if (!card) return;
  const r = card.getBoundingClientRect();
  card.style.setProperty('--mx', `${e.clientX - r.left}px`);
  card.style.setProperty('--my', `${e.clientY - r.top}px`);
}, {passive: true});

// ───────────── prateleira horizontal ─────────────

function shelf({title, sub, ic, load, more, kind = 'card', count = 8}) {
  const sec = h('section', {class: 'shelf reveal'});
  sec.innerHTML = `
    <header class="shelf-head">
      <div class="shelf-title">${ic ? `<span class="shelf-ic">${icon(ic)}</span>` : ''}<div><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div></div>
      <div class="shelf-nav">
        ${more ? `<button class="link-more">Ver tudo ${icon('arrowRight')}</button>` : ''}
        <button class="nav-btn prev" aria-label="Anterior">${icon('left')}</button>
        <button class="nav-btn next" aria-label="Próximo">${icon('right')}</button>
      </div>
    </header>
    <div class="shelf-viewport"><div class="shelf-track ${kind === 'shot' ? 'track-shots' : ''}"></div></div>`;
  const track = $('.shelf-track', sec);
  for (let i = 0; i < (kind === 'shot' ? 4 : count); i++) track.append(kind === 'shot' ? h('div', {class: 'shot-card skel'}) : skelCard(i));
  if (more) $('.link-more', sec).addEventListener('click', more);
  const step = dir => track.scrollBy({left: dir * track.clientWidth * 0.8, behavior: 'smooth'});
  $('.prev', sec).addEventListener('click', () => step(-1));
  $('.next', sec).addEventListener('click', () => step(1));
  const sync = () => {
    sec.classList.toggle('at-start', track.scrollLeft < 8);
    sec.classList.toggle('at-end', track.scrollLeft + track.clientWidth > track.scrollWidth - 8);
  };
  track.addEventListener('scroll', sync, {passive: true});
  Promise.resolve().then(load).then(items => {
    track.replaceChildren(...items.map((x, i) => (kind === 'shot' ? shotCard(x, i) : appCard(x, i))));
    track.classList.add('loaded');
    requestAnimationFrame(sync);
  }).catch(err => {
    track.replaceChildren(h('div', {class: 'inline-error', html: `${icon('alert')} Não foi possível carregar (${esc(err.message)})`}));
  });
  return sec;
}

// ───────────── grade infinita ─────────────

function infiniteGrid(ctx, fetchPage, {per = 36, onTotal, empty} = {}) {
  const wrap = h('div', {class: 'grid-wrap'});
  const grid = h('div', {class: 'grid'});
  const sentinel = h('div', {class: 'sentinel'});
  const status = h('div', {class: 'grid-status'});
  wrap.append(grid, status, sentinel);
  let page = 0, done = false, busy = false, count = 0;

  async function more() {
    if (busy || done || !ctx.alive) return;
    busy = true;
    page++;
    const skel = Array.from({length: page === 1 ? 12 : 6}, (_, i) => skelCard(i));
    grid.append(...skel);
    try {
      const r = await fetchPage(page, per);
      if (!ctx.alive) return;
      skel.forEach(s => s.remove());
      if (page === 1) onTotal?.(r.totalHits ?? r.hits.length);
      const frag = document.createDocumentFragment();
      r.hits.forEach((hit, i) => frag.append(appCard(hit, i)));
      grid.append(frag);
      count += r.hits.length;
      if (!r.hits.length || page >= (r.totalPages || 1)) {
        done = true;
        status.innerHTML = count ? `<span class="end-mark">${icon('sparkle')} Você viu todos os ${fmt.num(count)} apps</span>` : (empty || '<div class="empty-mini">Nada encontrado.</div>');
      }
    } catch (e) {
      skel.forEach(s => s.remove());
      page--;
      status.innerHTML = `<div class="inline-error">${icon('alert')} Erro ao carregar: ${esc(e.message)} <button class="btn btn-ghost btn-sm retry">Tentar de novo</button></div>`;
      $('.retry', status).onclick = () => { status.innerHTML = ''; more(); };
    } finally {
      busy = false;
    }
    if (!done && ctx.alive) requestAnimationFrame(() => {
      const r = sentinel.getBoundingClientRect();
      if (r.top < innerHeight + 900) more();
    });
  }

  const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) more(); }, {root: $('#scroller'), rootMargin: '900px'});
  io.observe(sentinel);
  ctx.onCleanup(() => io.disconnect());
  more();
  return wrap;
}

// ───────────── toasts ─────────────

function toast(text, {ic = 'check', tone = 'ok', img = null, ms = 3600} = {}) {
  const t = h('div', {class: `toast toast-${tone}`});
  t.innerHTML = `${img ? `<img src="${esc(img)}" alt="">` : `<span class="toast-ic">${icon(ic)}</span>`}<span class="toast-text">${esc(text)}</span>`;
  $('#toasts').append(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('in')));
  setTimeout(() => {
    t.classList.remove('in');
    t.classList.add('out');
    setTimeout(() => t.remove(), 500);
  }, ms);
}

// ───────────── confete ao concluir ─────────────

function burst(el) {
  if (!S.config.motion) return;
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const colors = ['#a78bfa', '#22d3ee', '#34d399', '#f472b6', '#fbbf24', '#ffffff', '#818cf8'];
  for (let i = 0; i < 34; i++) {
    const p = h('i', {class: 'particle'});
    const a = Math.random() * Math.PI * 2;
    const d = 50 + Math.random() * 110;
    const s = 4 + Math.random() * 6;
    p.style.cssText = `left:${cx}px;top:${cy}px;width:${s}px;height:${s * (Math.random() > .5 ? 1 : 2.2)}px;background:${colors[i % colors.length]};border-radius:${Math.random() > .5 ? '50%' : '2px'}`;
    document.body.append(p);
    p.animate([
      {transform: 'translate(-50%,-50%) rotate(0) scale(1)', opacity: 1},
      {transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d - 20}px)) rotate(${Math.random() * 360}deg) scale(1)`, opacity: 1, offset: 0.55},
      {transform: `translate(calc(-50% + ${Math.cos(a) * d * 1.25}px), calc(-50% + ${Math.sin(a) * d + 60}px)) rotate(${Math.random() * 720}deg) scale(.4)`, opacity: 0},
    ], {duration: 900 + Math.random() * 500, easing: 'cubic-bezier(.2,.7,.3,1)'}).onfinish = () => p.remove();
  }
}

// ───────────── modais ─────────────

function modal({title, body, actions = [], cls = '', onClose} = {}) {
  const m = h('div', {class: `modal ${cls}`});
  m.innerHTML = `<div class="modal-backdrop"></div><div class="modal-card" role="dialog" aria-modal="true">
    <button class="modal-x" aria-label="Fechar">${icon('x')}</button>
    ${title ? `<h2 class="modal-title">${title}</h2>` : ''}<div class="modal-body"></div><div class="modal-actions"></div></div>`;
  const bodyEl = $('.modal-body', m);
  if (body instanceof Node) bodyEl.append(body);
  else bodyEl.innerHTML = body || '';
  const actEl = $('.modal-actions', m);
  let closed = false;
  const close = (val) => {
    if (closed) return;
    closed = true;
    m.classList.remove('in');
    m.classList.add('out');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => m.remove(), 380);
    onClose?.(val);
  };
  for (const a of actions) {
    const b = h('button', {class: `btn ${a.kind || 'btn-ghost'}`, html: a.label});
    b.addEventListener('click', () => a.onClick ? a.onClick(close, b) : close(a.value));
    actEl.append(b);
  }
  if (!actions.length) actEl.remove();
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
  document.addEventListener('keydown', onKey, true);
  $('.modal-backdrop', m).addEventListener('click', () => close(null));
  $('.modal-x', m).addEventListener('click', () => close(null));
  $('#overlays').append(m);
  requestAnimationFrame(() => requestAnimationFrame(() => m.classList.add('in')));
  return {el: m, body: bodyEl, actions: actEl, close};
}

function confirmDialog({title, text, cmd, confirm = 'Confirmar', danger = false, img}) {
  return new Promise(resolve => {
    modal({
      cls: 'modal-sm',
      title: `${img ? `<img class="modal-app" src="${esc(img)}" alt="">` : ''}${esc(title)}`,
      body: `<p>${esc(text)}</p>${cmd ? `<code class="cmd-inline">$ ${esc(cmd)}</code>` : ''}`,
      actions: [
        {label: 'Cancelar', kind: 'btn-ghost', value: false},
        {label: confirm, kind: danger ? 'btn-danger-solid' : 'btn-primary', value: true},
      ],
      onClose: v => resolve(!!v),
    });
  });
}

function openSetupModal(app) {
  const body = h('div', {class: 'setup'});
  const render = (state, op) => {
    if (state === 'intro') {
      body.innerHTML = `
        <div class="orb"><div class="orb-core">${icon('box')}</div><i></i><i></i><i></i></div>
        <h2>Vamos preparar seu Ubuntu</h2>
        <p>Para instalar ${app ? `<b>${esc(app.name)}</b> e ` : ''}os mais de 3 mil apps do Flathub, a Vitrine usa o <b>Flatpak</b>, que ainda não está instalado neste sistema.</p>
        <p class="muted">Ao continuar, o Ubuntu vai pedir sua senha uma única vez para instalar o Flatpak e ativar o repositório Flathub.</p>
        <code class="cmd-inline">$ sudo apt install flatpak && flatpak remote-add flathub</code>
        <div class="setup-actions">
          <button class="btn btn-ghost" data-x>Agora não</button>
          <button class="btn btn-primary btn-lg" data-go>${icon('zap')}<span>Instalar Flatpak</span><i class="sheen"></i></button>
        </div>`;
      $('[data-x]', body).onclick = () => m.close();
      $('[data-go]', body).onclick = async () => {
        try {
          const op = await Bridge.call('setup');
          onOp(op);
          watch(op.opId);
        } catch (e) { toast(e.message, {tone: 'bad', ic: 'alert'}); }
      };
    } else if (state === 'run') {
      if (!$('.setup-run', body)) {
        body.innerHTML = `<div class="setup-run">
          <div class="orb spinning"><div class="orb-core">${icon('box')}</div><i></i><i></i><i></i></div>
          <h2>Configurando o Flatpak…</h2><p class="muted setup-phase">Aguardando autorização</p>
          <pre class="term mini-term"></pre></div>`;
      }
      $('.setup-phase', body).textContent = op.phase || '';
      const t = $('.term', body);
      t.textContent = op.tail || '';
      t.scrollTop = t.scrollHeight;
    } else if (state === 'done') {
      body.innerHTML = `<div class="setup-done">
        <div class="done-check"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24"/><path d="M15 27l7 7 15-16"/></svg></div>
        <h2>Tudo pronto!</h2>
        <p>O Flatpak e o Flathub estão ativos. Agora é só escolher e clicar em <b>Instalar</b>.</p>
        <p class="muted">Dica: se os apps instalados não aparecerem no menu do Ubuntu, saia e entre de novo na sessão uma vez.</p>
        <div class="setup-actions"><button class="btn btn-primary btn-lg" data-x>Começar</button></div></div>`;
      $('[data-x]', body).onclick = () => m.close();
    } else if (state === 'error') {
      body.innerHTML = `<div class="setup-done">
        <div class="orb err"><div class="orb-core">${icon('alert')}</div></div>
        <h2>Não deu certo</h2><p>${esc(op.error || 'A instalação falhou.')}</p>
        <p class="muted">Você também pode instalar pelo terminal:</p>
        <code class="cmd-inline">$ sudo apt install flatpak</code>
        <div class="setup-actions"><button class="btn btn-ghost" data-x>Fechar</button><button class="btn btn-primary" data-retry>Tentar de novo</button></div></div>`;
      $('[data-x]', body).onclick = () => m.close();
      $('[data-retry]', body).onclick = () => render('intro');
    }
  };
  let watching = null;
  const watch = opId => {
    watching = e => {
      const op = S.ops.get(opId);
      if (!op) return;
      if (op.status === 'done') render('done', op);
      else if (op.status === 'error' || op.status === 'cancelled') render('error', op);
      else render('run', op);
    };
    Events.addEventListener('ops', watching);
    watching();
  };
  render('intro');
  const m = modal({cls: 'modal-setup', body, onClose: () => watching && Events.removeEventListener('ops', watching)});
}

function openSettings() {
  const body = h('div', {class: 'settings'});
  const draw = () => {
    const env = S.env;
    body.innerHTML = `
      <h3 class="set-h">Onde instalar os apps</h3>
      <div class="seg-cards">
        <label class="seg-card ${S.config.scope === 'user' ? 'on' : ''}"><input type="radio" name="scope" value="user" ${S.config.scope === 'user' ? 'checked' : ''}>
          <span class="seg-ic">${icon('user')}</span><b>Só para mim</b><small>Sem pedir senha. Mostra o progresso em tempo real. <code>--user</code></small></label>
        <label class="seg-card ${S.config.scope === 'system' ? 'on' : ''}"><input type="radio" name="scope" value="system" ${S.config.scope === 'system' ? 'checked' : ''}>
          <span class="seg-ic">${icon('users')}</span><b>Para todos os usuários</b><small>O Ubuntu pode pedir sua senha. <code>--system</code></small></label>
      </div>
      <h3 class="set-h">Aparência</h3>
      <label class="switch-row"><span><b>Animações</b><small>Transições, brilhos e efeitos de movimento</small></span>
        <input type="checkbox" class="switch" name="motion" ${S.config.motion ? 'checked' : ''}></label>
      <label class="switch-row" style="margin-top:10px"><span><b>Aceleração por GPU</b><small>Desligue se a tela piscar ou ficar vazia. Vale ao reabrir a Vitrine.</small></span>
        <input type="checkbox" class="switch" name="gpu" ${S.config.gpu !== false ? 'checked' : ''}></label>
      <h3 class="set-h">Sistema</h3>
      <div class="about-grid">
        <span>Flatpak</span><b>${env.flatpak ? esc(env.version || 'instalado') : '<em class="bad">não instalado</em>'}</b>
        <span>Arquitetura</span><b>${esc(env.arch || '—')}</b>
        <span>Flathub (usuário)</span><b>${env.remotes?.user ? 'ativo' : '—'}</b>
        <span>Flathub (sistema)</span><b>${env.remotes?.system ? 'ativo' : '—'}</b>
        <span>Apps instalados</span><b>${S.installed.size}</b>
      </div>
      ${env.flatpak ? '' : `<button class="btn btn-primary" data-setup>${icon('zap')}<span>Instalar Flatpak</span></button>`}`;
    $$('input[name=scope]', body).forEach(r => r.onchange = () => { S.config.scope = r.value; saveConfig(); draw(); });
    $('input[name=motion]', body).onchange = e => { S.config.motion = e.target.checked; applyMotion(); saveConfig(); };
    $('input[name=gpu]', body).onchange = e => {
      S.config.gpu = e.target.checked;
      saveConfig();
      toast('Feche e abra a Vitrine para aplicar', {ic: 'info'});
    };
    const s = $('[data-setup]', body);
    if (s) s.onclick = () => { m.close(); openSetupModal(); };
  };
  draw();
  const m = modal({title: `${icon('sliders')} Preferências`, body, cls: 'modal-settings'});
}

function applyMotion() {
  document.documentElement.classList.toggle('no-motion', !S.config.motion);
}

// ───────────── lightbox de capturas de tela ─────────────

function openLightbox(shots, index, fromImg) {
  const lb = h('div', {class: 'lightbox'});
  lb.innerHTML = `<div class="lb-backdrop"></div>
    <div class="lb-stage"><img class="lb-img" alt="" draggable="false"></div>
    <div class="lb-caption"></div>
    <button class="lb-btn lb-close" aria-label="Fechar">${icon('x')}</button>
    <button class="lb-btn lb-prev" aria-label="Anterior">${icon('left')}</button>
    <button class="lb-btn lb-next" aria-label="Próxima">${icon('right')}</button>
    <div class="lb-dots">${shots.map((_, i) => `<i data-i="${i}"></i>`).join('')}</div>`;
  $('#overlays').append(lb);
  const img = $('.lb-img', lb);
  let i = index;

  const show = (n, dir = 0) => {
    i = (n + shots.length) % shots.length;
    const s = shots[i];
    const next = pickShot(s, 1600);
    $('.lb-caption', lb).textContent = s.caption || '';
    $$('.lb-dots i', lb).forEach((d, k) => d.classList.toggle('on', k === i));
    if (dir && S.config.motion) {
      img.animate([{opacity: 1, transform: 'translateX(0) scale(1)'}, {opacity: 0, transform: `translateX(${-dir * 60}px) scale(.97)`}], {duration: 160, easing: 'ease-in'}).onfinish = () => {
        img.src = next;
        img.animate([{opacity: 0, transform: `translateX(${dir * 60}px) scale(.97)`}, {opacity: 1, transform: 'none'}], {duration: 380, easing: 'cubic-bezier(.16,1,.3,1)'});
      };
    } else img.src = next;
  };

  const flip = (reverse = false) => {
    if (!fromImg || !S.config.motion || !fromImg.isConnected) return null;
    const a = fromImg.getBoundingClientRect();
    const b = img.getBoundingClientRect();
    if (!b.width || !a.width) return null;
    const t = `translate(${a.left + a.width / 2 - (b.left + b.width / 2)}px, ${a.top + a.height / 2 - (b.top + b.height / 2)}px) scale(${a.width / b.width})`;
    const frames = [{transform: t, borderRadius: '18px'}, {transform: 'none', borderRadius: '14px'}];
    return img.animate(reverse ? frames.reverse() : frames, {duration: reverse ? 320 : 520, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'both'});
  };

  img.src = fromImg?.currentSrc || pickShot(shots[i], 1600);
  show(i);
  requestAnimationFrame(() => {
    lb.classList.add('in');
    if (img.complete) flip(); else img.addEventListener('load', () => flip(), {once: true});
  });

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    lb.classList.remove('in');
    lb.classList.add('out');
    const anim = i === index ? flip(true) : null;
    setTimeout(() => lb.remove(), anim ? 330 : 300);
  };
  const onKey = e => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'ArrowRight') show(i + 1, 1);
    else if (e.key === 'ArrowLeft') show(i - 1, -1);
  };
  document.addEventListener('keydown', onKey, true);
  $('.lb-backdrop', lb).onclick = close;
  $('.lb-stage', lb).onclick = e => { if (e.target !== img) close(); };
  $('.lb-close', lb).onclick = close;
  $('.lb-prev', lb).onclick = () => show(i - 1, -1);
  $('.lb-next', lb).onclick = () => show(i + 1, 1);
  $$('.lb-dots i', lb).forEach(d => d.onclick = () => show(Number(d.dataset.i), Number(d.dataset.i) > i ? 1 : -1));
  if (shots.length < 2) lb.classList.add('single');
}

// ───────────── dock de atividades (fila de instalação + terminal) ─────────────

const Dock = {
  el: null, open: false, selected: null, hideTimer: null,
  init() {
    this.el = $('#dock');
    this.el.innerHTML = `
      <div class="dock-panel">
        <header><h3>${icon('terminal')} Atividade</h3><div><button class="btn btn-ghost btn-sm" data-clear>Limpar concluídas</button><button class="icon-btn" data-close>${icon('chevDown')}</button></div></header>
        <div class="dock-list"></div>
        <div class="dock-term"><div class="term-head"><span class="dots"><i></i><i></i><i></i></span><code class="term-cmd"></code><button class="icon-btn" data-copy title="Copiar comando">${icon('copy')}</button></div><pre class="term"></pre></div>
      </div>
      <button class="dock-pill">
        <span class="dock-ring"><svg viewBox="0 0 36 36"><circle class="ring-bg" cx="18" cy="18" r="15.5"/><circle class="ring-fg" cx="18" cy="18" r="15.5" stroke-dasharray="${RING}" stroke-dashoffset="${RING}"/></svg><span class="dock-ic"></span></span>
        <span class="dock-text"><b></b><small></small></span>
        <span class="dock-badge"></span>
      </button>`;
    $('.dock-pill', this.el).onclick = () => this.toggle();
    $('[data-close]', this.el).onclick = () => this.toggle(false);
    $('[data-clear]', this.el).onclick = async () => {
      for (const [k, op] of S.ops) if (!['running', 'queued'].includes(op.status)) S.ops.delete(k);
      try { await Bridge.call('clear-ops'); } catch {}
      this.selected = null;
      this.update();
    };
    $('[data-copy]', this.el).onclick = () => {
      const op = S.ops.get(this.selected);
      if (op?.cmd) { Bridge.call('copy', {text: op.cmd}); toast('Comando copiado', {ic: 'copy'}); }
    };
  },
  toggle(v = !this.open) {
    this.open = v;
    this.el.classList.toggle('open', v);
    if (v) this.update();
  },
  update() {
    emitState('ops');
    const list = [...S.ops.values()].reverse();
    const active = list.filter(o => o.status === 'running' || o.status === 'queued');
    const running = list.find(o => o.status === 'running') || active[0];
    const recent = list[0];
    const show = active.length > 0 || this.open || (recent && Date.now() - (recent._seen || (recent._seen = Date.now())) < 5000);
    this.el.classList.toggle('show', !!(show && list.length));
    clearTimeout(this.hideTimer);
    if (!active.length && !this.open && list.length) this.hideTimer = setTimeout(() => this.update(), 5200);

    const pill = $('.dock-pill', this.el);
    const cur = running || recent;
    if (cur) {
      const p = cur.progress;
      const fg = $('.ring-fg', pill);
      const indet = (cur.status === 'running' && p == null) || cur.status === 'queued';
      pill.classList.toggle('spin', indet);
      fg.style.strokeDashoffset = cur.status === 'done' ? 0 : indet ? RING * 0.72 : RING * (1 - (p || 0));
      pill.dataset.status = cur.status;
      const ic = $('.dock-ic', pill);
      const want = cur.icon || '';
      if (ic.dataset.src !== want) {
        ic.dataset.src = want;
        ic.innerHTML = want ? `<img src="${esc(want)}" alt="">` : icon(cur.kind === 'setup' ? 'box' : 'download');
      }
      $('.dock-text b', pill).textContent = cur.status === 'done' ? `${cur.name} pronto` : cur.status === 'error' ? `Falha: ${cur.name}` : cur.name;
      $('.dock-text small', pill).textContent = cur.status === 'running'
        ? `${cur.phase || ''}${p != null ? ` · ${Math.floor(p * 100)}%` : ''}`
        : cur.status === 'queued' ? 'Na fila' : cur.status === 'done' ? 'Concluído' : cur.status === 'error' ? (cur.error || 'Erro') : 'Cancelado';
      const extra = active.length - 1;
      const badge = $('.dock-badge', pill);
      badge.textContent = extra > 0 ? `+${extra}` : '';
      badge.classList.toggle('on', extra > 0);
    }

    if (!this.open) return;
    if (!this.selected || !S.ops.has(this.selected)) this.selected = cur?.opId || null;
    const listEl = $('.dock-list', this.el);
    const KIND = {install: 'Instalar', uninstall: 'Remover', update: 'Atualizar', setup: 'Configurar'};
    listEl.innerHTML = list.length ? list.map(o => `
      <div class="op-row ${o.opId === this.selected ? 'sel' : ''}" data-op="${o.opId}" data-status="${o.status}">
        <span class="op-ic">${o.icon ? `<img src="${esc(o.icon)}" alt="">` : icon('box')}</span>
        <span class="op-main"><b>${esc(o.name || o.appId)}</b><small>${KIND[o.kind] || o.kind} · ${esc(o.status === 'error' ? (o.error || 'Erro') : o.status === 'done' ? 'Concluído' : o.status === 'queued' ? 'Na fila' : o.status === 'cancelled' ? 'Cancelado' : (o.phase || ''))}</small>
          <span class="op-bar ${o.status === 'running' && o.progress == null ? 'indet' : ''}"><i style="width:${o.status === 'done' ? 100 : Math.floor((o.progress || 0) * 100)}%"></i></span></span>
        <span class="op-end">${o.status === 'running' || o.status === 'queued' ? `<button class="icon-btn" data-cancel="${o.opId}" title="Cancelar">${icon('x')}</button>` : o.status === 'done' ? `<span class="ok">${icon('check')}</span>` : o.status === 'error' ? `<span class="bad">${icon('alert')}</span>` : ''}</span>
      </div>`).join('') : '<div class="empty-mini">Nenhuma atividade ainda.</div>';
    $$('.op-row', listEl).forEach(r => r.onclick = () => { this.selected = r.dataset.op; this.update(); });
    $$('[data-cancel]', listEl).forEach(b => b.onclick = e => { e.stopPropagation(); Bridge.call('cancel', {opId: b.dataset.cancel}); });
    const sel = S.ops.get(this.selected);
    $('.term-cmd', this.el).textContent = sel?.cmd ? `$ ${sel.cmd}` : '';
    const term = $('.dock-term .term', this.el);
    const stick = term.scrollTop + term.clientHeight >= term.scrollHeight - 30;
    term.textContent = sel?.tail || '';
    if (stick) term.scrollTop = term.scrollHeight;
  },
};
