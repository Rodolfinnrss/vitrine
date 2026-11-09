'use strict';
// ───────────── navegação, barra lateral, busca e inicialização ─────────────

const Router = {
  stack: [],
  top() { return this.stack[this.stack.length - 1]; },
};

function newCtx() {
  return {alive: true, cleanups: [], onCleanup(f) { this.cleanups.push(f); }};
}

function destroyEntry(e) {
  if (!e) return;
  if (e.ctx) {
    e.ctx.alive = false;
    for (const f of e.ctx.cleanups) { try { f(); } catch {} }
  }
  e.node?.remove();
  e.node = null;
  e.ctx = null;
}

function navigate(name, params = {}, opts = {}) {
  const prev = Router.top();
  if (prev) prev.scroll = $('#scroller').scrollTop;
  const entry = {name, params: {...params}, node: null, ctx: null, scroll: 0};
  let dropped = [];
  if (opts.root) {
    dropped = Router.stack;
    Router.stack = [entry];
  } else if (opts.replace && prev) {
    dropped = [Router.stack.pop()];
    Router.stack.push(entry);
  } else {
    Router.stack.push(entry);
    if (Router.stack.length > 24) dropped = Router.stack.splice(0, Router.stack.length - 24);
  }
  show(entry, {from: prev, dropped, morph: opts.morph, transition: opts.transition !== false});
}

function goBack() {
  if (Router.stack.length < 2) return;
  const leaving = Router.stack.pop();
  show(Router.top(), {from: leaving, dropped: [leaving], back: true});
}

function openApp(app, iconEl) {
  normApp(app);
  navigate('app', {id: app.id}, {morph: iconEl && iconEl.isConnected ? iconEl : null});
}

function show(entry, {from, dropped = [], morph = null, back = false, transition = true}) {
  const view = $('#view');
  const scroller = $('#scroller');
  const animate = S.config.motion && transition;

  // Ícone de origem para o efeito de "voar" até a próxima tela
  let fromIcon = null;
  if (animate) {
    if (morph?.isConnected) fromIcon = morph;
    else if (back && from?.name === 'app' && from.node) fromIcon = from.ctx?.morphEl || $('.dh-icon .app-icon', from.node);
  }
  const fromRect = fromIcon?.getBoundingClientRect();
  const fromSrc = fromIcon?.tagName === 'IMG' ? (fromIcon.currentSrc || fromIcon.src) : null;

  if (from?.node?.isConnected) {
    for (const a of from.node.getAnimations()) a.cancel();
    from.node.remove();
  }
  for (const d of dropped) if (d !== entry) destroyEntry(d);
  if (!entry.node) {
    entry.ctx = newCtx();
    entry.node = h('div', {class: `page page-${entry.name}`});
    VIEWS[entry.name](entry.node, entry.ctx, {...entry.params, morph: !!morph});
    view.append(entry.node);
    observeReveal(entry.node, entry.ctx);
  } else {
    view.append(entry.node);
    refreshActs();
  }
  scroller.scrollTop = entry.scroll || 0;
  syncChrome(entry);
  if (!animate) return;

  // Ícone de destino (medido antes da animação da página começar)
  let toIcon = null;
  if (morph) toIcon = entry.ctx?.morphEl || null;
  else if (back && from?.name === 'app') toIcon = $(`[data-app="${CSS.escape(from.params.id)}"] .app-icon`, entry.node);
  if (fromRect && fromSrc && toIcon) flyIcon(fromSrc, fromRect, toIcon);

  const dx = back ? -32 : 32;
  entry.node.animate(
    [{opacity: 0, transform: `translate3d(${dx}px, 0, 0)`}, {opacity: 1, transform: 'none'}],
    {duration: 480, easing: 'cubic-bezier(.16,1,.3,1)'},
  );
}

// Faz uma cópia do ícone "voar" da posição antiga até a nova (efeito de elemento compartilhado)
function flyIcon(src, a, toEl) {
  const b = toEl.getBoundingClientRect();
  if (!a.width || !b.width || b.bottom < 0 || b.top > innerHeight) return;
  const ghost = h('img', {class: 'fly-icon', src, alt: ''});
  ghost.style.cssText = `left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px`;
  document.body.append(ghost);
  toEl.classList.add('fly-target');
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    toEl.classList.remove('fly-target');
    ghost.remove();
  };
  const anim = ghost.animate(
    [{transform: `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${a.width / b.width})`}, {transform: 'none'}],
    {duration: 600, easing: 'cubic-bezier(.16,1,.3,1)'},
  );
  anim.onfinish = finish;
  anim.oncancel = finish;
  setTimeout(finish, 1200);
}

// ───────────── barra lateral ─────────────

function buildSidebar() {
  const nav = $('#nav');
  const item = (route, label, ic, extra = '') =>
    `<button class="nav-item" data-route="${route}"${extra}><span class="nav-ic">${icon(ic)}</span><span class="nav-label">${label}</span></button>`;
  nav.innerHTML = `
    <span class="nav-glider"></span>
    ${item('home', 'Início', 'home')}
    ${item('explore', 'Explorar', 'compass')}
    ${item('installed', 'Instalados', 'box')}
    ${item('updates', 'Atualizações', 'refresh')}
    <div class="nav-sep"><span>Categorias</span></div>
    ${CATEGORIES.map(c => `<button class="nav-item nav-cat" data-route="category" data-id="${c.id}" style="--c1:${c.c1};--c2:${c.c2}"><span class="nav-ic">${icon(c.icon)}</span><span class="nav-label">${c.label}</span></button>`).join('')}`;
  $('[data-route=installed]', nav).append(h('b', {class: 'badge', id: 'badge-installed'}));
  $('[data-route=updates]', nav).append(h('b', {class: 'badge badge-hot', id: 'badge-updates'}));
  nav.addEventListener('click', e => {
    const b = e.target.closest('.nav-item');
    if (!b) return;
    const params = b.dataset.id ? {id: b.dataset.id} : {};
    const top = Router.stack[0];
    if (Router.stack.length === 1 && top.name === b.dataset.route && (top.params.id || '') === (params.id || '')) {
      $('#scroller').scrollTo({top: 0, behavior: 'smooth'});
      return;
    }
    $('#search').value = '';
    navigate(b.dataset.route, params, {root: true});
  });
  const setBadges = () => {
    const bi = $('#badge-installed');
    bi.textContent = S.installed.size || '';
    bi.classList.toggle('on', S.installed.size > 0);
    const bu = $('#badge-updates');
    bu.textContent = S.updates.size || '';
    bu.classList.toggle('on', S.updates.size > 0);
  };
  Events.addEventListener('installed', setBadges);
  Events.addEventListener('updates', setBadges);
  Events.addEventListener('env', () => {
    const st = $('#fp-status');
    const ok = S.env.flatpak;
    st.className = `fp-status ${ok ? 'ok' : 'bad'}`;
    st.innerHTML = ok
      ? `<i></i><span>Flatpak ${esc(S.env.version || '')}</span>`
      : `<i></i><span>Flatpak ausente</span><button class="link" data-setup>Configurar</button>`;
    const b = $('[data-setup]', st);
    if (b) b.onclick = () => openSetupModal();
    // banner na tela inicial
    const home = Router.stack.find(e => e.name === 'home')?.node;
    if (home) {
      const existing = $('.banner', home);
      if (!ok && !existing) home.prepend(setupBanner());
      if (ok && existing) existing.remove();
      $$('.banner.reveal', home).forEach(el => el.classList.add('shown'));
    }
  });
}

function syncChrome(entry) {
  const root = Router.stack[0] || entry;
  const nav = $('#nav');
  let active = null;
  for (const b of $$('.nav-item', nav)) {
    const on = b.dataset.route === root.name && (b.dataset.id || '') === (root.params.id || '');
    b.classList.toggle('active', on);
    if (on) active = b;
  }
  const glider = $('.nav-glider', nav);
  if (active) {
    glider.style.opacity = 1;
    glider.style.transform = `translateY(${active.offsetTop}px)`;
    glider.style.height = `${active.offsetHeight}px`;
    const c = active.style.getPropertyValue('--c1');
    glider.style.setProperty('--g1', c || '');
  } else glider.style.opacity = 0;

  const back = $('#back');
  back.classList.toggle('show', Router.stack.length > 1);
  if (entry.name !== 'search' && entry.name !== 'app') document.title = 'Vitrine';
  const search = $('#search');
  if (entry.name === 'search') search.value = entry.params.q || '';
  else if (!Router.stack.some(e => e.name === 'search') && document.activeElement !== search) search.value = '';
  $('.search').classList.toggle('has-text', !!search.value);
}

// ───────────── busca ─────────────

function bindSearch() {
  const input = $('#search');
  const box = $('.search');
  const runSearch = () => {
    const q = input.value.trim();
    const top = Router.top();
    if (q) {
      if (top?.name === 'search') {
        if (top.params.q !== q) navigate('search', {q}, {replace: true, transition: false});
      } else navigate('search', {q});
    } else if (top?.name === 'search') goBack();
    box.classList.toggle('has-text', !!input.value);
  };
  const debounced = debounce(runSearch, 260);
  input.addEventListener('input', () => { box.classList.toggle('has-text', !!input.value); debounced(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') runSearch();
    if (e.key === 'Escape') {
      input.value = '';
      runSearch();
      input.blur();
    }
  });
  $('.search-clear').onclick = () => { input.value = ''; runSearch(); input.focus(); };
  input.addEventListener('focus', () => box.classList.add('focus'));
  input.addEventListener('blur', () => box.classList.remove('focus'));
}

function bindKeys() {
  document.addEventListener('keydown', e => {
    const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '');
    if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'f'))) {
      e.preventDefault();
      $('#search').focus();
      $('#search').select();
    } else if ((e.altKey && e.key === 'ArrowLeft') || (e.key === 'Backspace' && !typing) || (e.key === 'Escape' && !typing && !$('.modal, .lightbox'))) {
      if (Router.stack.length > 1) { e.preventDefault(); goBack(); }
    }
  });
  document.addEventListener('mouseup', e => { if (e.button === 3) goBack(); });
  $('#back').onclick = goBack;
  $('#btn-settings').onclick = openSettings;
  $('#btn-activity').onclick = () => Dock.toggle();
}

// ───────────── inicialização ─────────────

async function boot() {
  try { S.config = {...S.config, ...(await Bridge.call('config:get'))}; } catch {}
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches && S.config.motion == null) S.config.motion = false;
  applyMotion();
  buildSidebar();
  Dock.init();
  bindSearch();
  bindKeys();
  navigate('home', {}, {root: true, transition: false});
  document.body.classList.add('ready');

  Api.collection('popular', 1, 1).then(r => {
    $('#search').placeholder = `Pesquisar entre ${fmt.num(r.totalHits)} apps…`;
  }).catch(() => {});

  await refreshEnv();
  if (S.env.flatpak === false && !S.config.setupSeen) {
    S.config.setupSeen = true;
    saveConfig();
    setTimeout(() => openSetupModal(), 900);
  }
  try { (await Bridge.call('ops')).forEach(onOp); } catch {}
}

document.addEventListener('DOMContentLoaded', boot);
