// Viboplr server directory — live client-side fetch of the public directory API
// hosted at servers.viboplr.com (a separate FastAPI app; this static page only
// reads it). No build step, no framework. Mirrors the plugins/skins gallery
// pattern but with a different data source and card shape.

(function () {
  'use strict';

  // The directory's public read API. CORS on that service allows this origin
  // (see app/config.py CORS_ORIGINS). Submit/login/manage all live on the same
  // subdomain and are linked out to — this page never writes.
  var API_BASE = 'https://servers.viboplr.com';
  var API_URL = API_BASE + '/api/servers';

  var grid = document.getElementById('serverGrid');
  var statusEl = document.getElementById('serverStatus');
  var searchEl = document.getElementById('serverSearch');
  var countEl = document.getElementById('serverCount');
  if (!grid) return;

  var allItems = [];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function setStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.innerHTML = msg || '';
    statusEl.style.display = msg ? 'block' : 'none';
    statusEl.className = 'gallery-status' + (isError ? ' gallery-status--error' : '');
  }

  // Build the viboplr:// deep link the desktop app understands. Mirrors the
  // directory's own server-side builder (pages.py _deep_link): spaces encode as
  // '+' (x-www-form-urlencoded), matching what the app already parses. Empty
  // username/password are omitted rather than sent blank.
  function deepLink(s) {
    var p = new URLSearchParams({ kind: 'subsonic', name: s.name || '', url: s.url || '' });
    if (s.username) p.set('username', s.username);
    if (s.password) p.set('password', s.password);
    return 'viboplr://add-collection?' + p.toString();
  }

  // Show just the host, not the full URL — cleaner and enough to recognize.
  function hostOf(url) {
    try { return new URL(url).host || url; } catch (e) { return url || ''; }
  }

  function serverIcon() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/>' +
      '<line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>';
  }

  function addButton(s) {
    return '<a class="btn btn-primary btn-sm gallery-install" href="' + esc(deepLink(s)) + '">' +
      '<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
      '<polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Add to Viboplr</a>';
  }

  function serverCard(s) {
    var tags = Array.isArray(s.tags) ? s.tags : [];
    var pills = '<span class="gallery-meta-pill">Subsonic</span>' +
      tags.map(function (t) { return '<span class="gallery-meta-pill">' + esc(t) + '</span>'; }).join('');
    var login = s.username ? '<span>login: ' + esc(s.username) + '</span>' : '';
    var details = s.id != null
      ? '<a class="gallery-source" href="' + esc(API_BASE + '/servers/' + s.id) + '" target="_blank" rel="noopener">Details ↗</a>'
      : '';
    var desc = s.description
      ? '<p class="gallery-card-desc">' + esc(s.description) + '</p>'
      : '';
    return (
      '<div class="gallery-card">' +
        '<div class="gallery-card-icon">' + serverIcon() + '</div>' +
        '<div class="gallery-card-body">' +
          '<div class="gallery-card-head"><h3>' + esc(s.name) + '</h3></div>' +
          '<span class="gallery-card-id">' + esc(hostOf(s.url)) + '</span>' +
          desc +
          '<div class="gallery-card-meta">' + pills + login + '</div>' +
          '<div class="gallery-card-actions">' + addButton(s) + '</div>' +
          '<div class="gallery-card-links">' + details + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function emptyState() {
    return '<div class="server-empty">' +
      '<p>No servers listed yet.</p>' +
      '<p><a href="' + API_BASE + '/login" target="_blank" rel="noopener">Be the first to share one →</a></p>' +
      '</div>';
  }

  function render(items, searching) {
    if (!allItems.length) {
      // Whole directory is empty (not a no-match search).
      grid.innerHTML = emptyState();
      setStatus('');
      if (countEl) countEl.textContent = '';
      return;
    }
    if (!items.length) {
      grid.innerHTML = '';
      setStatus('No servers match your search.');
      if (countEl) countEl.textContent = '';
      return;
    }
    setStatus('');
    if (countEl) {
      countEl.textContent = items.length + (items.length === 1 ? ' server' : ' servers');
    }
    grid.innerHTML = items.map(serverCard).join('');
  }

  function applySearch() {
    var q = (searchEl && searchEl.value || '').trim().toLowerCase();
    if (!q) return render(allItems, false);
    var filtered = allItems.filter(function (s) {
      var tags = (Array.isArray(s.tags) ? s.tags.join(' ') : '');
      return (
        String(s.name || '').toLowerCase().indexOf(q) !== -1 ||
        String(s.description || '').toLowerCase().indexOf(q) !== -1 ||
        String(s.url || '').toLowerCase().indexOf(q) !== -1 ||
        tags.toLowerCase().indexOf(q) !== -1
      );
    });
    render(filtered, true);
  }

  // --- boot ---
  setStatus('Loading servers…');
  fetch(API_URL, { cache: 'no-cache' }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).then(function (list) {
    if (!Array.isArray(list)) throw new Error('Unexpected API response');
    // Alphabetical by name for a stable read (the API returns a random sample).
    allItems = list.slice().sort(function (a, b) {
      return String(a.name).localeCompare(String(b.name));
    });
    render(allItems, false);
    if (searchEl) searchEl.addEventListener('input', applySearch);
  }).catch(function (e) {
    console.error('Server directory load failed:', e);
    setStatus('Couldn’t load the server directory right now. You can browse it directly at ' +
      '<a href="' + API_BASE + '" target="_blank" rel="noopener">servers.viboplr.com</a>.', true);
  });
})();
