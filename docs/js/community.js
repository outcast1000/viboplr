// Community page — Viboplr Community's three areas, built from the community
// server itself (all CORS-open reads):
//   GET /v1/modules                   what can be shared, each module with its `area`
//   GET /v1/subjects/search?q=        Music: songs, albums and artists by name
//   GET /v1/activity                  Music: what was shared lately
//   GET /v1/items/search?kind=<kind>  the other areas: their latest items, each with a `card`
// Music has no list per kind: cue sheets and synced lyrics live on their
// song's page, so the Music section is a search box and the feed. The page
// knows no module by name; a new module shows up in its area as soon as the
// server lists it. Read-only — every write happens on the community site or
// in the app.

(function () {
  'use strict';

  var API_BASE = 'https://community.viboplr.com';
  var SHOWN = 6;
  var AREAS = [
    { id: 'music', name: 'Music', intro: 'Songs, albums and artists, each with one page holding everything people shared about it: cue sheets, synced lyrics, likes and comments.' },
    { id: 'mixtapes', name: 'Mixtapes' },
    { id: 'servers', name: 'Subsonic servers' },
  ];

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

  // A module's area. Servers older than the `area` field: music unless it's
  // a mixtape or members-only.
  function areaOf(m) {
    if (m.area) return m.area;
    if (m.membersOnly) return 'servers';
    return m.kind === 'mixtape' ? 'mixtapes' : 'music';
  }

  function icon() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/>' +
      '<polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>';
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
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
    var likes = it.likes ? '<span>♥ ' + esc(it.likes) + '</span>' : '';
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
          '<div class="gallery-card-meta">' + facts + by + count + likes + '</div>' +
          action +
          '<div class="gallery-card-links"><a class="gallery-source" href="' + esc(it.url) + '" target="_blank" rel="noopener">Details ↗</a></div>' +
        '</div>' +
      '</div>'
    );
  }

  // What is shared about a subject, as pills: each module's count, then
  // comments and likes.
  function subjectPills(s, byKind) {
    var out = [];
    Object.keys(s.counts || {}).forEach(function (kind) {
      var m = byKind[kind];
      if (m) out.push(plural(s.counts[kind], m.singular, m.plural));
    });
    if (s.comments) out.push(plural(s.comments, 'comment', 'comments'));
    if (s.likes) out.push('♥ ' + s.likes);
    return out.map(function (p) { return '<span class="gallery-meta-pill">' + esc(p) + '</span>'; }).join('');
  }

  var KIND_LABEL = { track: 'Song', album: 'Album', artist: 'Artist' };

  function subjectCard(s, byKind) {
    var by = s.kind !== 'artist' && s.artistName ? ' · ' + esc(s.artistName) : '';
    return (
      '<div class="gallery-card">' +
        '<div class="gallery-card-icon">' + icon() + '</div>' +
        '<div class="gallery-card-body">' +
          '<div class="gallery-card-head"><h3><a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.name) + '</a></h3></div>' +
          '<div class="gallery-card-meta"><span>' + esc(KIND_LABEL[s.kind] || s.kind) + by + '</span>' + subjectPills(s, byKind) + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  // One feed entry: who did what, linking to the page it belongs to.
  function feedCard(e, byKind) {
    var s = e.subject;
    var who, what, link;
    if (e.type === 'comment') {
      who = e.comment.author.login;
      what = 'commented on ' + (s ? s.name : 'a song');
      link = e.comment.url;
    } else {
      var m = byKind[e.item.kind] || { singular: 'item' };
      who = e.item.publisher.login;
      what = (e.event === 'updated' ? 'updated ' : 'shared ') + (s ? 'a ' + m.singular + ' for ' + s.name : 'the ' + m.singular + ' ' + e.item.title);
      link = s ? s.url : e.item.url;
    }
    var by = s && s.kind !== 'artist' && s.artistName ? '<span>' + esc(s.artistName) + '</span>' : '';
    return (
      '<div class="gallery-card">' +
        '<div class="gallery-card-icon">' + icon() + '</div>' +
        '<div class="gallery-card-body">' +
          '<div class="gallery-card-head"><h3><a href="' + esc(link) + '" target="_blank" rel="noopener">' + esc(what) + '</a></h3></div>' +
          '<div class="gallery-card-meta"><span>by @' + esc(who) + '</span>' + by + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function sectionHtml(area, mods, index) {
    var lead = mods[0];
    var intro = area.intro || (lead && lead.intro) || '';
    var notice = area.id === 'music' ? '' : mods.filter(function (m) { return m.notice; }).map(function (m) {
      return '<div class="community-notice" role="note"><p>' + esc(m.notice) + '</p></div>';
    }).join('');
    var share = mods.filter(function (m) { return m.shareUrl; }).map(function (m) {
      return '<a href="' + esc(m.shareUrl) + '" class="btn btn-outline" target="_blank" rel="noopener" data-track="share" data-module="' +
        esc(m.slug) + '">Share a ' + esc(m.singular) + '</a>';
    }).join('');
    var browse = area.id === 'music'
      ? '<a href="' + API_BASE + '/activity" target="_blank" rel="noopener">All activity on community.viboplr.com &rarr;</a>'
      : '<a href="' + esc(lead.url) + '" target="_blank" rel="noopener">Browse all ' + esc(lead.plural || lead.name.toLowerCase()) + ' on community.viboplr.com &rarr;</a>';
    var search = area.id === 'music'
      ? '<form class="community-search" data-search role="search"><input type="search" name="q" placeholder="Find an artist, album or song" aria-label="Find music">' +
        '<button type="submit" class="btn btn-primary">Search</button></form><div class="gallery-grid" data-results></div>' +
        '<h3 class="community-subhead">New this week</h3>'
      : '';
    return (
      '<section class="section' + (index % 2 ? ' section-alt' : '') + '" id="' + esc(area.id) + '">' +
        '<div class="container">' +
          '<div class="section-header">' +
            '<span class="feature-label">' + esc(area.name) + '</span>' +
            '<h2>' + esc(area.name) + '</h2>' +
            '<p>' + esc(intro) + '</p>' +
          '</div>' +
          notice + search +
          '<div class="gallery-status" data-status></div>' +
          '<div class="gallery-grid" data-grid></div>' +
          '<div class="community-more">' + browse + share + '</div>' +
        '</div>' +
      '</section>'
    );
  }

  function failed(status, url, what, e) {
    console.error('Community ' + what + ' load failed:', e);
    status.innerHTML = 'Couldn’t load these right now. See them at <a href="' + esc(url) + '" target="_blank" rel="noopener">community.viboplr.com</a>.';
    status.className = 'gallery-status gallery-status--error';
    status.style.display = 'block';
  }

  function fillMusic(el, byKind) {
    var grid = el.querySelector('[data-grid]');
    var status = el.querySelector('[data-status]');
    var results = el.querySelector('[data-results]');
    var form = el.querySelector('[data-search]');
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var q = form.q.value.trim();
      if (!q) { results.innerHTML = ''; return; }
      results.innerHTML = '<div class="community-empty"><p>Searching…</p></div>';
      getJson('/v1/subjects/search?q=' + encodeURIComponent(q)).then(function (data) {
        var rows = data && Array.isArray(data.subjects) ? data.subjects.slice(0, 9) : [];
        var more = '<div class="community-empty"><p><a href="' + API_BASE + '/search?q=' + encodeURIComponent(q) +
          '" target="_blank" rel="noopener">All results on community.viboplr.com →</a></p></div>';
        results.innerHTML = rows.length
          ? rows.map(function (s) { return subjectCard(s, byKind); }).join('') + more
          : '<div class="community-empty"><p>Nothing shared matches that yet.</p></div>';
      }).catch(function (e) {
        console.error('Community search failed:', e);
        results.innerHTML = '<div class="community-empty"><p>Search isn’t available right now. Try it on <a href="' + API_BASE +
          '/search?q=' + encodeURIComponent(q) + '" target="_blank" rel="noopener">community.viboplr.com</a>.</p></div>';
      });
    });
    status.textContent = 'Loading…';
    status.style.display = 'block';
    getJson('/v1/activity').then(function (data) {
      var entries = data && Array.isArray(data.entries) ? data.entries.slice(0, SHOWN) : [];
      status.style.display = 'none';
      grid.innerHTML = entries.length
        ? entries.map(function (e) { return feedCard(e, byKind); }).join('')
        : '<div class="community-empty"><p>Nothing shared yet — be the first.</p></div>';
    }).catch(function (e) { failed(status, API_BASE + '/activity', 'activity', e); });
  }

  function fillArea(el, m) {
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
    }).catch(function (e) { failed(status, m.url, m.kind, e); });
  }

  setStatus('Loading…');
  getJson('/v1/modules').then(function (data) {
    var mods = data && Array.isArray(data.modules) ? data.modules : [];
    if (!mods.length) throw new Error('no modules');
    var byKind = {};
    mods.forEach(function (m) { byKind[m.kind] = m; });
    var areas = AREAS.map(function (a) {
      return { area: a, mods: mods.filter(function (m) { return areaOf(m) === a.id; }) };
    }).filter(function (x) { return x.mods.length; });
    root.innerHTML = areas.map(function (x, i) { return sectionHtml(x.area, x.mods, i); }).join('');
    if (jump) {
      jump.innerHTML = areas.map(function (x) {
        return '<a href="#' + esc(x.area.id) + '" class="btn btn-outline">' + esc(x.area.name) + '</a>';
      }).join('');
    }
    areas.forEach(function (x) {
      var el = document.getElementById(x.area.id);
      if (x.area.id === 'music') fillMusic(el, byKind);
      else x.mods.forEach(function (m) { fillArea(el, m); });
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
