// Community page — one section per module on Viboplr Community, built from
// the community server itself:
//   GET /v1/modules                       what can be shared (name, intro, notice, URLs)
//   GET /v1/items/search?kind=<kind>      the latest items, each with a `card`
// Both reads are CORS-open for exactly this. The page knows nothing about any
// particular module: a new kind of thing to share appears here as soon as the
// server lists it. Read-only — every write happens on the community site or
// in the app.

(function () {
  'use strict';

  var API_BASE = 'https://community.viboplr.com';
  var SHOWN = 6;

  var root = document.getElementById('communityModules');
  var statusEl = document.getElementById('communityStatus');
  var jump = document.getElementById('communityJump');
  if (!root) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function getJson(path) {
    return fetch(API_BASE + path, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function setStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.innerHTML = msg || '';
    statusEl.style.display = msg ? 'block' : 'none';
    statusEl.className = 'gallery-status' + (isError ? ' gallery-status--error' : '');
  }

  function icon() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/>' +
      '<polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>';
  }

  function uses(m, n) {
    var noun = Array.isArray(m.useNoun) ? m.useNoun[n === 1 ? 0 : 1] : '';
    return n + ' ' + noun;
  }

  // One item, from its card alone.
  function itemCard(m, it) {
    var card = it.card || { title: it.title, facts: [] };
    var facts = (card.facts || []).map(function (f) {
      return '<span class="gallery-meta-pill">' + esc(f) + '</span>';
    }).join('');
    var by = it.publisher && it.publisher.login ? '<span>by @' + esc(it.publisher.login) + '</span>' : '';
    var count = it.importCount ? '<span>' + esc(uses(m, it.importCount)) + '</span>' : '';
    var action = card.action && card.action.link
      ? '<div class="gallery-card-actions"><a class="btn btn-primary btn-sm gallery-install" href="' + esc(card.action.link) +
        '" data-track="app-action" data-module="' + esc(m.slug) + '">' +
        esc(card.action.label) + '</a></div>'
      : '';
    return (
      '<div class="gallery-card">' +
        '<div class="gallery-card-icon">' + icon() + '</div>' +
        '<div class="gallery-card-body">' +
          '<div class="gallery-card-head"><h3>' + esc(card.title) + '</h3></div>' +
          '<div class="gallery-card-meta">' + facts + by + count + '</div>' +
          action +
          '<div class="gallery-card-links"><a class="gallery-source" href="' + esc(it.url) + '" target="_blank" rel="noopener">Details ↗</a></div>' +
        '</div>' +
      '</div>'
    );
  }

  function sectionHtml(m, index) {
    var share = m.shareUrl
      ? '<a href="' + esc(m.shareUrl) + '" class="btn btn-outline" target="_blank" rel="noopener" data-track="share" data-module="' +
        esc(m.slug) + '">Share a ' + esc(m.singular) + '</a>'
      : '';
    return (
      '<section class="section' + (index % 2 ? ' section-alt' : '') + '" id="' + esc(m.slug) + '">' +
        '<div class="container">' +
          '<div class="section-header">' +
            '<span class="feature-label">' + esc(m.name) + '</span>' +
            '<h2>' + esc(m.name) + '</h2>' +
            '<p>' + esc(m.intro) + '</p>' +
          '</div>' +
          (m.notice ? '<div class="community-notice" role="note"><p>' + esc(m.notice) + '</p></div>' : '') +
          '<div class="gallery-status" data-status></div>' +
          '<div class="gallery-grid" data-grid></div>' +
          '<div class="community-more">' +
            '<a href="' + esc(m.url) + '" target="_blank" rel="noopener">Browse all ' + esc(m.plural || m.name.toLowerCase()) + ' on community.viboplr.com &rarr;</a>' +
            share +
          '</div>' +
        '</div>' +
      '</section>'
    );
  }

  function fillSection(el, m) {
    var grid = el.querySelector('[data-grid]');
    var status = el.querySelector('[data-status]');
    // Members-only listings need a sign-in this page can't do (and the server
    // answers it 401): point at the community site instead of fetching.
    if (m.membersOnly) {
      grid.innerHTML = '<div class="community-empty"><p>' + esc(m.name) + ' are for signed-in members. ' +
        '<a href="' + esc(m.url) + '" target="_blank" rel="noopener">Sign in with GitHub on community.viboplr.com</a> to see them, or open <strong>Community</strong> in Viboplr.</p></div>';
      return;
    }
    status.textContent = 'Loading…';
    status.style.display = 'block';
    getJson('/v1/items/search?kind=' + encodeURIComponent(m.kind) + '&sort=recent').then(function (data) {
      var items = data && Array.isArray(data.items) ? data.items.slice(0, SHOWN) : [];
      status.style.display = 'none';
      grid.innerHTML = items.length
        ? items.map(function (it) { return itemCard(m, it); }).join('')
        : '<div class="community-empty"><p>Nothing shared yet — be the first.</p></div>';
    }).catch(function (e) {
      console.error('Community section load failed (' + m.kind + '):', e);
      status.innerHTML = 'Couldn’t load these right now. Browse them at <a href="' + esc(m.url) +
        '" target="_blank" rel="noopener">community.viboplr.com</a>.';
      status.className = 'gallery-status gallery-status--error';
    });
  }

  setStatus('Loading…');
  getJson('/v1/modules').then(function (data) {
    var mods = data && Array.isArray(data.modules) ? data.modules : [];
    if (!mods.length) throw new Error('no modules');
    root.innerHTML = mods.map(sectionHtml).join('');
    if (jump) {
      jump.innerHTML = mods.map(function (m) {
        return '<a href="#' + esc(m.slug) + '" class="btn btn-outline">' + esc(m.name) + '</a>';
      }).join('');
    }
    mods.forEach(function (m) {
      fillSection(document.getElementById(m.slug), m);
    });
    // Land on a section when the URL names one (e.g. community.html#servers).
    if (location.hash) {
      var target = document.getElementById(location.hash.slice(1));
      if (target) target.scrollIntoView();
    }
  }).catch(function (e) {
    console.error('Community modules load failed:', e);
    setStatus('Couldn’t reach Viboplr Community right now. Visit it directly at ' +
      '<a href="' + API_BASE + '" target="_blank" rel="noopener">community.viboplr.com</a>.', true);
  });
})();
