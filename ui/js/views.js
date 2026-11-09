'use strict';
// ───────────── telas ─────────────

const SORTS = [
  {id: 'popular', label: 'Populares', ic: 'star', sub: 'Os mais instalados no último mês'},
  {id: 'trending', label: 'Em alta', ic: 'flame', sub: 'Crescendo mais rápido agora'},
  {id: 'recently-added', label: 'Novos', ic: 'sparkle', sub: 'Acabaram de chegar ao Flathub'},
  {id: 'recently-updated', label: 'Atualizados', ic: 'refresh', sub: 'Receberam novas versões'},
  {id: 'verified', label: 'Verificados', ic: 'shield', sub: 'Publicados pelos próprios desenvolvedores'},
];

function pageHead({kicker, title, sub, ic, c1, c2}) {
  return h('header', {class: 'page-head reveal', style: c1 ? `--c1:${c1};--c2:${c2}` : '', html: `
    ${ic ? `<div class="ph-ic">${icon(ic)}</div>` : ''}
    <div>${kicker ? `<span class="kicker">${kicker}</span>` : ''}<h1>${title}</h1>${sub ? `<p class="ph-sub">${sub}</p>` : ''}</div>`});
}

function setupBanner() {
  const b = h('div', {class: 'banner reveal', html: `
    <div class="banner-ic">${icon('zap')}</div>
    <div class="banner-text"><b>O Flatpak ainda não está instalado</b><span>Ele é necessário para instalar os apps. A Vitrine configura tudo para você com um clique.</span></div>
    <button class="btn btn-primary">${icon('download')}<span>Configurar agora</span><i class="sheen"></i></button>`});
  $('button', b).onclick = () => openSetupModal();
  return b;
}

// ───────────── Início ─────────────

const VIEWS = {};

VIEWS.home = (node, ctx) => {
  if (S.env.flatpak === false) node.append(setupBanner());
  node.append(heroCarousel(ctx));
  node.append(shelf({
    title: 'Em evidência', sub: 'Os favoritos da comunidade, com fotos', ic: 'sparkle', kind: 'shot',
    load: async () => {
      const p = await Api.collection('popular', 1, 14);
      const ds = await Promise.allSettled(p.hits.slice(0, 12).map(x => Api.details(x.app_id)));
      return ds.filter(r => r.status === 'fulfilled' && r.value?.screenshots?.length).map(r => r.value);
    },
  }));
  node.append(shelf({title: 'Mais populares', sub: 'O que todo mundo está instalando', ic: 'star', load: () => Api.collection('popular', 1, 24).then(r => r.hits), more: () => navigate('explore', {sort: 'popular'})}));
  node.append(categoriesSection());
  node.append(shelf({title: 'Em alta', sub: 'Subindo rápido esta semana', ic: 'flame', load: () => Api.collection('trending', 1, 24).then(r => r.hits), more: () => navigate('explore', {sort: 'trending'})}));
  node.append(shelf({title: 'Novidades no Flathub', sub: 'Acabaram de chegar', ic: 'sparkle', load: () => Api.collection('recently-added', 1, 24).then(r => r.hits), more: () => navigate('explore', {sort: 'recently-added'})}));
  node.append(shelf({title: 'Jogos', sub: 'Para jogar no Linux', ic: 'gamepad', load: () => Api.category('Game', 1, 24).then(r => r.hits), more: () => navigate('category', {id: 'Game'})}));
  node.append(shelf({title: 'Criatividade', sub: 'Desenho, foto e design', ic: 'palette', load: () => Api.category('Graphics', 1, 24).then(r => r.hits), more: () => navigate('category', {id: 'Graphics'})}));
  node.append(shelf({title: 'Atualizados recentemente', sub: 'Versões novinhas', ic: 'refresh', load: () => Api.collection('recently-updated', 1, 24).then(r => r.hits), more: () => navigate('explore', {sort: 'recently-updated'})}));
  node.append(h('footer', {class: 'foot', html: `${icon('heart')} Dados e imagens do <a href="https://flathub.org">Flathub</a>. Instalação via <code>flatpak</code>.`}));
  observeReveal(node, ctx);
};

function categoriesSection() {
  const sec = h('section', {class: 'shelf reveal'});
  sec.innerHTML = `<header class="shelf-head"><div class="shelf-title"><span class="shelf-ic">${icon('grid')}</span><div><h2>Categorias</h2><p>Encontre o app certo para cada coisa</p></div></div></header><div class="cat-grid"></div>`;
  const grid = $('.cat-grid', sec);
  CATEGORIES.forEach((c, i) => {
    const t = h('button', {class: 'cat-tile', style: `--c1:${c.c1};--c2:${c.c2};--i:${i}`, html: `
      <span class="cat-name">${c.label}</span><span class="cat-count" data-cat-count="${c.id}">&nbsp;</span>
      <span class="cat-art">${icon(c.icon)}</span><span class="cat-shine"></span>`});
    t.onclick = () => navigate('category', {id: c.id});
    grid.append(t);
    Api.category(c.id, 1, 1).then(r => { const el = $(`[data-cat-count="${c.id}"]`, grid); if (el) el.textContent = `${fmt.num(r.totalHits)} apps`; }).catch(() => {});
  });
  return sec;
}

function heroCarousel(ctx) {
  const hero = h('section', {class: 'hero is-loading'});
  hero.innerHTML = `<div class="hero-slides"><div class="hero-skel"><div class="sk"></div></div></div>
    <div class="hero-dots"></div>
    <button class="hero-arrow prev" aria-label="Anterior">${icon('left')}</button>
    <button class="hero-arrow next" aria-label="Próximo">${icon('right')}</button>`;
  const slidesEl = $('.hero-slides', hero);
  const dotsEl = $('.hero-dots', hero);
  let cur = 0, slides = [];

  const go = (n, dir = 1) => {
    if (!slides.length) return;
    const prev = cur;
    cur = (n + slides.length) % slides.length;
    slides.forEach((s, i) => {
      s.classList.toggle('active', i === cur);
      s.classList.toggle('leaving', i === prev && prev !== cur);
      s.style.setProperty('--dir', dir);
    });
    $$('button', dotsEl).forEach((d, i) => {
      d.classList.toggle('active', i === cur);
      const bar = $('i', d);
      bar.style.animation = 'none';
      void bar.offsetWidth;
      bar.style.animation = '';
    });
  };
  $('.prev', hero).onclick = () => go(cur - 1, -1);
  $('.next', hero).onclick = () => go(cur + 1, 1);
  dotsEl.addEventListener('animationend', e => {
    if (e.animationName === 'dot-fill' && S.config.motion && ctx.alive && e.target.parentElement?.classList.contains('active')) go(cur + 1, 1);
  });

  hero.addEventListener('pointermove', e => {
    const r = hero.getBoundingClientRect();
    hero.style.setProperty('--px', ((e.clientX - r.left) / r.width - 0.5).toFixed(3));
    hero.style.setProperty('--py', ((e.clientY - r.top) / r.height - 0.5).toFixed(3));
  }, {passive: true});
  hero.addEventListener('pointerleave', () => { hero.style.setProperty('--px', 0); hero.style.setProperty('--py', 0); });

  (async () => {
    const picks = [];
    const today = todayISO();
    try { const d = await Api.appOfDay(today); if (d?.app_id) picks.push({id: d.app_id, label: 'App do dia'}); } catch {}
    try {
      const w = await Api.appsOfWeek(today);
      (w.apps || []).sort((a, b) => a.position - b.position).forEach(a => picks.push({id: a.app_id, label: 'App da semana'}));
    } catch {}
    if (picks.length < 3) {
      try { (await Api.collection('popular', 1, 6)).hits.forEach(x => picks.push({id: x.app_id, label: 'Popular'})); } catch {}
    }
    const seen = new Set();
    const uniq = picks.filter(p => !seen.has(p.id) && seen.add(p.id)).slice(0, 7);
    const ds = await Promise.allSettled(uniq.map(p => Api.details(p.id)));
    const items = uniq.map((p, i) => ({...p, d: ds[i].status === 'fulfilled' ? ds[i].value : null})).filter(x => x.d && x.d.screenshots?.length);
    if (!ctx.alive) return;
    if (!items.length) { hero.remove(); return; }

    slides = items.map(({d, label}, i) => {
      const app = normApp(d);
      const big = pickShot(d.screenshots[0], 1248);
      const mid = pickShot(d.screenshots[0], 752);
      const brand = hexToRgb(app.brand);
      const s = h('article', {class: 'hero-slide', 'data-app': app.id, style: brand ? `--brand:${liftColor(brand, 120).join(',')}` : ''});
      s.innerHTML = `
        <div class="hero-bg"><img src="${esc(big)}" alt="" draggable="false"></div>
        <div class="hero-shade"></div>
        <div class="hero-content">
          <span class="eyebrow">${icon('sparkle')} ${esc(label)}</span>
          <div class="hero-app">${appIcon(app, 'hero-icon')}<div><h2>${esc(app.name)}</h2><span>${esc(app.developer)}${app.verified ? ` <i class="verified">${icon('verified')}</i>` : ''}</span></div></div>
          <p class="hero-sum">${esc(app.summary)}</p>
          <div class="hero-actions"></div>
        </div>
        <div class="hero-shot"><div class="frame"><img src="${esc(mid)}" alt="" draggable="false"></div></div>`;
      $('.hero-actions', s).append(actionButton(app, 'big'), h('button', {class: 'btn btn-glass btn-lg', html: `<span>Ver detalhes</span>${icon('arrowRight')}`, onclick: () => openApp(app, $('.hero-icon', s))}));
      $('.hero-shot', s).onclick = () => openApp(app, $('.hero-icon', s));
      if (!brand) dominantColor(app.icon).then(rgb => rgb && s.style.setProperty('--brand', liftColor(rgb, 120).join(',')));
      dotsEl.append(h('button', {'aria-label': `Destaque ${i + 1}`, html: '<i></i>', onclick: () => go(i, i > cur ? 1 : -1)}));
      return s;
    });
    slidesEl.replaceChildren(...slides);
    hero.classList.remove('is-loading');
    go(0);
  })();
  return hero;
}

// ───────────── Explorar ─────────────

VIEWS.explore = (node, ctx, {sort = 'popular'} = {}) => {
  const head = pageHead({kicker: 'Catálogo completo', title: 'Explorar', sub: 'Todos os apps do Flathub, com instalação em um clique', ic: 'compass'});
  node.append(head);
  const bar = h('div', {class: 'toolbar reveal'});
  const seg = h('div', {class: 'seg'}, h('span', {class: 'seg-pill'}));
  SORTS.forEach(s => seg.append(h('button', {class: 'seg-btn', 'data-sort': s.id, html: `${icon(s.ic)}<span>${s.label}</span>`})));
  const chips = h('div', {class: 'chips'});
  CATEGORIES.forEach(c => chips.append(h('button', {class: 'chip', style: `--c1:${c.c1};--c2:${c.c2}`, html: `${icon(c.icon)}<span>${c.label}</span>`, onclick: () => navigate('category', {id: c.id})})));
  bar.append(seg);
  node.append(bar, chips);
  const count = h('div', {class: 'result-count'});
  node.append(count);
  const holder = h('div');
  node.append(holder);

  let gridCtx = null;
  const select = id => {
    sort = id;
    if (Router.top()) Router.top().params.sort = id;
    $$('.seg-btn', seg).forEach(b => b.classList.toggle('on', b.dataset.sort === id));
    moveSegPill(seg);
    const meta = SORTS.find(s => s.id === id);
    if (gridCtx) { gridCtx.alive = false; gridCtx.cleanups.forEach(f => f()); }
    gridCtx = childCtx(ctx);
    count.innerHTML = `<span class="rc-sub">${meta.sub}</span>`;
    const g = infiniteGrid(gridCtx, (page, per) => Api.collection(id, page, per), {
      onTotal: n => { count.innerHTML = `<b>${fmt.num(n)}</b> apps · <span class="rc-sub">${meta.sub}</span>`; },
    });
    holder.replaceChildren(g);
  };
  $$('.seg-btn', seg).forEach(b => b.onclick = () => select(b.dataset.sort));
  select(sort);
  requestAnimationFrame(() => moveSegPill(seg, true));
  observeReveal(node, ctx);
};

function moveSegPill(seg, instant = false) {
  const on = $('.seg-btn.on', seg);
  const pill = $('.seg-pill', seg);
  if (!on || !pill) return;
  if (instant) pill.style.transition = 'none';
  pill.style.width = `${on.offsetWidth}px`;
  pill.style.transform = `translateX(${on.offsetLeft}px)`;
  if (instant) requestAnimationFrame(() => (pill.style.transition = ''));
}

function childCtx(parent) {
  const c = {alive: true, cleanups: [], onCleanup(f) { this.cleanups.push(f); }};
  parent.onCleanup(() => { c.alive = false; c.cleanups.forEach(f => f()); });
  return c;
}

// ───────────── Categoria ─────────────

VIEWS.category = (node, ctx, {id}) => {
  const c = catOf(id) || {id, label: id, icon: 'grid', c1: '#6366f1', c2: '#22d3ee'};
  const banner = h('section', {class: 'cat-banner reveal', style: `--c1:${c.c1};--c2:${c.c2}`, html: `
    <div class="cb-text"><span class="kicker">Categoria</span><h1>${c.label}</h1><p class="cb-count">&nbsp;</p></div>
    <div class="cb-art">${icon(c.icon)}</div><div class="cb-orbs"><i></i><i></i><i></i></div>`});
  node.append(banner);
  node.append(infiniteGrid(ctx, (page, per) => Api.category(c.id, page, per), {
    onTotal: n => { $('.cb-count', banner).textContent = `${fmt.num(n)} apps para explorar`; },
  }));
  observeReveal(node, ctx);
};

// ───────────── Busca ─────────────

VIEWS.search = (node, ctx, {q}) => {
  const head = h('header', {class: 'search-head', html: `<span class="kicker">Pesquisa</span><h1>Resultados para <em>“${esc(q)}”</em></h1><p class="ph-sub">&nbsp;</p>`});
  node.append(head);
  node.append(infiniteGrid(ctx, (page, per) => Api.search(q, page, per), {
    onTotal: n => { $('.ph-sub', head).textContent = n ? `${fmt.num(n)} ${n === 1 ? 'app encontrado' : 'apps encontrados'}` : ''; },
    empty: `<div class="empty"><div class="empty-art">${icon('search')}</div><h2>Nada por aqui</h2><p>Nenhum app corresponde a “${esc(q)}”. Tente outra palavra, como o nome ou o que o app faz.</p></div>`,
  }));
};

// ───────────── Detalhes do app ─────────────

VIEWS.app = (node, ctx, {id, morph}) => {
  const base = S.apps.get(id) || {id, name: id, summary: '', icon: null};
  node.classList.add('detail');
  node.innerHTML = `
    <section class="dh" data-glow>
      <div class="dh-bg"><img alt="" draggable="false"></div>
      <div class="dh-main">
        <div class="dh-icon">${appIcon(base, 'big')}</div>
        <div class="dh-info">
          <h1 class="dh-name">${esc(base.name)}</h1>
          <div class="dh-dev">${base.developer ? esc(base.developer) : '&nbsp;'}</div>
          <p class="dh-sum">${esc(base.summary)}</p>
          <div class="dh-actions"></div>
          <div class="dh-cmd glow-follow"><span class="prompt">$</span><code>flatpak install flathub ${esc(id)}</code><button class="icon-btn" title="Copiar comando">${icon('copy')}</button></div>
        </div>
      </div>
      <div class="dh-stats">${Array.from({length: 5}, () => '<div class="stat skel"><i></i><b></b><span></span></div>').join('')}</div>
    </section>
    <section class="shots"><div class="shots-track"><div class="shot skel"></div><div class="shot skel"></div></div>
      <button class="nav-btn shots-prev">${icon('left')}</button><button class="nav-btn shots-next">${icon('right')}</button></section>
    <section class="dh-cols">
      <article class="dh-desc reveal"><h2>Sobre</h2><div class="desc-body"><div class="sk-para"><i></i><i></i><i></i><i class="short"></i></div></div></article>
      <aside class="dh-side reveal"></aside>
    </section>
    <div class="dh-similar"></div>`;

  const iconEl = $('.dh-icon .app-icon', node);
  if (iconEl) ctx.morphEl = iconEl;
  $('.dh-actions', node).append(actionButton(base, 'big'));
  $('.dh-cmd button', node).onclick = () => {
    Bridge.call('copy', {text: `flatpak install flathub ${id}`});
    toast('Comando copiado', {ic: 'copy'});
  };
  const track = $('.shots-track', node);
  $('.shots-prev', node).onclick = () => track.scrollBy({left: -track.clientWidth * 0.75, behavior: 'smooth'});
  $('.shots-next', node).onclick = () => track.scrollBy({left: track.clientWidth * 0.75, behavior: 'smooth'});

  (async () => {
    let d;
    try {
      d = await Api.details(id);
    } catch (e) {
      if (!ctx.alive) return;
      $('.dh-cols', node).innerHTML = `<div class="inline-error">${icon('alert')} Não foi possível carregar os detalhes: ${esc(e.message)}</div>`;
      return;
    }
    if (!ctx.alive) return;
    const app = normApp(d);
    $('.dh-name', node).textContent = app.name;
    $('.dh-dev', node).innerHTML = `${esc(app.developer || 'Desenvolvedor desconhecido')}${app.verified ? ` <span class="verified-chip">${icon('verified')} Verificado</span>` : ''}`;
    $('.dh-sum', node).textContent = app.summary;
    $('.dh-actions [data-act]', node)._app = app;
    document.title = `${app.name} — Vitrine`;

    // ícone em alta resolução (troca sem piscar)
    const hi = (d.icons || []).find(i => i.scale === 2) || null;
    if (hi && iconEl && iconEl.tagName === 'IMG') {
      const pre = new Image();
      pre.onload = () => { if (ctx.alive) iconEl.src = hi.url; };
      pre.src = hi.url;
    } else if (!base.icon && app.icon) {
      const wrap = $('.dh-icon', node);
      wrap.innerHTML = appIcon(app, 'big');
    }

    // cor da marca
    const brand = hexToRgb(app.brand);
    const applyTint = rgb => node.style.setProperty('--tint', liftColor(rgb, 130).join(','));
    if (brand) applyTint(brand);
    else dominantColor(app.icon).then(rgb => rgb && ctx.alive && applyTint(rgb));

    // capturas de tela
    const shots = (d.screenshots || []).filter(s => s.sizes?.length);
    if (shots.length) {
      const bg = $('.dh-bg img', node);
      bg.onload = () => bg.classList.add('ok');
      bg.src = pickShot(shots[0], 752);
      track.replaceChildren(...shots.map((s, i) => {
        const fig = h('figure', {class: 'shot', style: `--i:${i}`});
        fig.innerHTML = `<img src="${esc(pickShot(s, 752))}" alt="" loading="${i < 3 ? 'eager' : 'lazy'}" decoding="async" draggable="false"><span class="shot-zoom">${icon('maximize')}</span>${s.caption ? `<figcaption>${esc(s.caption)}</figcaption>` : ''}`;
        fig.onclick = () => openLightbox(shots, i, $('img', fig));
        return fig;
      }));
      $('.shots', node).classList.toggle('single', shots.length < 2);
    } else {
      $('.shots', node).remove();
    }

    // descrição
    const desc = $('.desc-body', node);
    desc.innerHTML = sanitizeHTML(d.description) || '<p class="muted">Sem descrição.</p>';
    requestAnimationFrame(() => {
      if (desc.scrollHeight > 380) {
        desc.classList.add('clamp');
        const more = h('button', {class: 'btn btn-ghost btn-sm read-more', html: `<span>Ler mais</span>${icon('chevDown')}`});
        more.onclick = () => {
          const open = desc.classList.toggle('open');
          desc.style.maxHeight = open ? `${desc.scrollHeight}px` : '';
          $('span', more).textContent = open ? 'Mostrar menos' : 'Ler mais';
          more.classList.toggle('flip', open);
        };
        desc.after(more);
      }
    });

    // lateral: novidades, links, categorias
    const side = $('.dh-side', node);
    const rel = (d.releases || []).slice(0, 4);
    const LINKS = [['homepage', 'Site oficial', 'globe'], ['bugtracker', 'Relatar problema', 'bug'], ['help', 'Ajuda', 'help'], ['donation', 'Fazer doação', 'heart'], ['vcs_browser', 'Código-fonte', 'code'], ['translate', 'Ajudar a traduzir', 'globe'], ['contribute', 'Contribuir', 'users']];
    const links = LINKS.filter(([k]) => d.urls?.[k]);
    side.innerHTML = `
      ${rel.length ? `<div class="side-card"><h3>${icon('sparkle')} Novidades</h3>${rel.map((r, i) => `
        <details class="rel" ${i === 0 ? 'open' : ''}><summary><b>Versão ${esc(r.version || '?')}</b><span>${fmt.date(r.timestamp)}</span>${icon('chevDown')}</summary>
        <div class="rel-body">${sanitizeHTML(r.description) || '<p class="muted">Sem notas desta versão.</p>'}</div></details>`).join('')}</div>` : ''}
      ${links.length ? `<div class="side-card"><h3>${icon('external')} Links</h3><div class="links">${links.map(([k, label, ic]) => `<button class="link-btn" data-url="${esc(d.urls[k])}">${icon(ic)}<span>${label}</span>${icon('external', 'ext')}</button>`).join('')}</div></div>` : ''}
      ${(d.categories || []).length ? `<div class="side-card"><h3>${icon('tag')} Categorias</h3><div class="tags">${d.categories.slice(0, 8).map(c => { const cc = catOf(c); return `<button class="tag ${cc ? 'tag-main' : ''}" ${cc ? `data-cat="${cc.id}" style="--c1:${cc.c1};--c2:${cc.c2}"` : 'disabled'}>${esc(cc ? cc.label : c)}</button>`; }).join('')}</div></div>` : ''}`;
    $$('[data-url]', side).forEach(b => b.onclick = () => Bridge.call('open', {url: b.dataset.url}));
    $$('[data-cat]', side).forEach(b => b.onclick = () => navigate('category', {id: b.dataset.cat}));

    // estatísticas
    const [sum, st] = await Promise.allSettled([Api.summary(id), Api.stats(id)]);
    if (!ctx.alive) return;
    const summ = sum.status === 'fulfilled' ? sum.value : {};
    const stats = st.status === 'fulfilled' ? st.value : {};
    const lic = d.project_license || '';
    const items = [
      ['download', fmt.compact(stats.installs_total), 'downloads no total'],
      ['disk', fmt.bytes(summ.installed_size), 'tamanho instalado'],
      ['download', fmt.bytes(summ.download_size), 'para baixar'],
      ['tag', rel[0]?.version ? `v${rel[0].version}` : '—', rel[0]?.timestamp ? `atualizado ${fmt.ago(rel[0].timestamp)}` : 'versão'],
      [d.is_free_license ? 'heart' : 'lock', d.is_free_license ? 'Livre' : 'Proprietário', lic.length > 26 ? 'licença' : (lic.replace(/^LicenseRef-proprietary.*/, 'licença') || 'licença')],
    ];
    $('.dh-stats', node).innerHTML = items.map(([ic, v, l], i) => `<div class="stat" style="--i:${i}"><i>${icon(ic)}</i><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');

    // semelhantes
    const main = catOf(app.category) || catOf((d.categories || [])[0]);
    if (main) {
      const sim = shelf({
        title: `Mais em ${main.label}`, ic: main.icon,
        load: () => Api.category(main.id, 1, 25).then(r => r.hits.filter(x => x.app_id !== id).slice(0, 24)),
        more: () => navigate('category', {id: main.id}),
      });
      $('.dh-similar', node).append(sim);
    }
    observeReveal(node, ctx);
  })();
};

// ───────────── Instalados ─────────────

function installedRow(inst, i) {
  const app = S.apps.get(inst.id) || {id: inst.id, name: inst.name || inst.id, icon: null};
  const row = h('div', {class: 'inst-row', style: `--i:${i}`, 'data-app': inst.id, 'data-glow': ''});
  row.innerHTML = `
    <div class="inst-icon">${appIcon(app)}</div>
    <div class="inst-main"><b>${esc(app.name || inst.name)}</b><span>${esc(inst.id)}</span></div>
    <div class="inst-meta"><span>${inst.version ? `v${esc(inst.version)}` : '—'}</span><span>${esc(inst.size || '')}</span><span class="scope-pill">${inst.installation === 'system' ? 'Sistema' : 'Usuário'}</span></div>`;
  row.append(actionButton(app, 'big'));
  row.addEventListener('click', e => { if (!e.target.closest('[data-act]')) openApp(app, $('.app-icon', row)); });
  if (!app.icon) {
    Api.details(inst.id).then(d => {
      const a = normApp(d);
      $('.inst-icon', row).innerHTML = appIcon(a);
      $('.inst-main b', row).textContent = a.name;
      $('[data-act]', row)._app = a;
    }).catch(() => {});
  }
  return row;
}

VIEWS.installed = (node, ctx) => {
  node.append(pageHead({kicker: 'Sua biblioteca', title: 'Instalados', sub: 'Apps Flatpak neste computador', ic: 'box'}));
  const list = h('div', {class: 'inst-list'});
  node.append(list);
  const draw = () => {
    if (!ctx.alive) return;
    if (S.env.flatpak === false) {
      list.replaceChildren(h('div', {class: 'empty', html: `<div class="empty-art">${icon('box')}</div><h2>O Flatpak não está instalado</h2><p>Configure o Flatpak para começar a instalar apps do Flathub.</p><button class="btn btn-primary btn-lg">${icon('zap')}<span>Configurar agora</span></button>`}));
      $('button', list).onclick = () => openSetupModal();
      return;
    }
    const items = [...S.installed.values()].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    if (!items.length) {
      list.replaceChildren(h('div', {class: 'empty', html: `<div class="empty-art">${icon('download')}</div><h2>Nenhum app ainda</h2><p>Que tal começar pelos mais populares?</p><button class="btn btn-primary btn-lg">${icon('compass')}<span>Explorar apps</span></button>`}));
      $('button', list).onclick = () => navigate('explore', {}, {root: true});
      return;
    }
    list.replaceChildren(...items.map(installedRow));
  };
  draw();
  const on = () => draw();
  Events.addEventListener('installed', on);
  Events.addEventListener('env', on);
  ctx.onCleanup(() => { Events.removeEventListener('installed', on); Events.removeEventListener('env', on); });
};

// ───────────── Atualizações ─────────────

VIEWS.updates = (node, ctx) => {
  node.append(pageHead({kicker: 'Mantenha tudo em dia', title: 'Atualizações', sub: 'Novas versões dos seus apps', ic: 'refresh'}));
  const actions = h('div', {class: 'upd-actions'});
  const list = h('div', {class: 'inst-list'});
  node.append(actions, list);
  const draw = () => {
    if (!ctx.alive) return;
    const items = [...S.updates.values()];
    actions.innerHTML = `<button class="btn btn-ghost" data-check>${icon('refresh')}<span>Procurar de novo</span></button>
      ${items.length ? `<button class="btn btn-primary" data-all>${icon('download')}<span>Atualizar tudo (${items.length})</span><i class="sheen"></i></button>` : ''}`;
    $('[data-check]', actions).onclick = async e => {
      const b = e.currentTarget;
      b.classList.add('spinning');
      await refreshUpdates();
      b.classList.remove('spinning');
      toast(S.updates.size ? `${S.updates.size} atualizações disponíveis` : 'Tudo atualizado', {ic: 'refresh'});
    };
    const all = $('[data-all]', actions);
    if (all) all.onclick = async () => {
      const scopes = [...new Set(items.map(u => u.scope))];
      for (const scope of scopes) onOp(await Bridge.call('update', {scope, name: scope === 'system' ? 'Todos (sistema)' : 'Todos os apps'}));
    };
    if (!S.env.flatpak) {
      list.replaceChildren(h('div', {class: 'empty', html: `<div class="empty-art">${icon('refresh')}</div><h2>Sem Flatpak</h2><p>Configure o Flatpak para gerenciar atualizações.</p>`}));
      return;
    }
    if (!items.length) {
      list.replaceChildren(h('div', {class: 'empty happy', html: `<div class="empty-art">${icon('check')}</div><h2>Tudo em dia</h2><p>Todos os seus apps estão na versão mais recente.</p>`}));
      return;
    }
    list.replaceChildren(...items.map((u, i) => {
      const inst = S.installed.get(u.id) || {};
      return installedRow({...inst, id: u.id, version: u.version, installation: inst.installation || u.scope}, i);
    }));
  };
  draw();
  const on = () => draw();
  Events.addEventListener('updates', on);
  Events.addEventListener('installed', on);
  ctx.onCleanup(() => { Events.removeEventListener('updates', on); Events.removeEventListener('installed', on); });
};

// Revela seções ao rolar
function observeReveal(node, ctx) {
  let fired = false;
  const io = new IntersectionObserver(es => {
    fired = true;
    for (const e of es) if (e.isIntersecting) { e.target.classList.add('shown'); io.unobserve(e.target); }
  }, {root: $('#scroller'), rootMargin: '0px 0px -40px 0px'});
  const els = $$('.reveal:not(.shown)', node);
  els.forEach(el => io.observe(el));
  ctx.onCleanup(() => io.disconnect());
  // Garantia: se o observador não responder, mostra tudo (nada pode ficar invisível)
  setTimeout(() => { if (!fired && ctx.alive) els.forEach(el => el.classList.add('shown')); }, 1200);
}
