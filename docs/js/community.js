// Community page — the "Cue sheets" section: the latest sheets shared on
// Viboplr Community, read live from its public API (GET /v1/items/search,
// CORS-open for exactly this). Read-only; importing happens in the app through
// the Community plugin, so cards link to each sheet's page rather than
// offering an action this site can't perform. The Servers section is
// js/servers.js.

(function () {
  'use strict';

  var API_BASE = 'https://community.viboplr.com';
  var API_URL = API_BASE + '/v1/items/search?kind=cue_sheet&sort=recent';
  var SHOWN = 6;

  var grid = document.getElementById('cueGrid');
  var statusEl = document.getElementById('cueStatus');
  if (!grid) return;

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

  function cueIcon() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/>' +
      '<line x1="7" y1="9" x2="17" y2="9"/><line x1="7" y1="12" x2="13" y2="12"/>' +
      '<line x1="8" y1="20" x2="16" y2="20"/></svg>';
  }

  function cueCard(it) {
    var n = it.cueCount || 0;
    var pills =
      '<span class="gallery-meta-pill">' + (it.mode === 'clip' ? 'Lyric clip' : 'Cards') + '</span>' +
      '<span class="gallery-meta-pill">' + n + (n === 1 ? ' cue' : ' cues') + '</span>';
    var by = it.publisher && it.publisher.login ? '<span>by @' + esc(it.publisher.login) + '</span>' : '';
    return (
      '<div class="gallery-card">' +
        '<div class="gallery-card-icon">' + cueIcon() + '</div>' +
        '<div class="gallery-card-body">' +
          '<div class="gallery-card-head"><h3>' + esc(it.title) + '</h3></div>' +
          '<span class="gallery-card-id">' + esc(it.artistName || '') + '</span>' +
          '<div class="gallery-card-meta">' + pills + by + '</div>' +
          '<div class="gallery-card-links"><a class="gallery-source" href="' + esc(it.url || (API_BASE + '/c/' + it.id)) +
            '" target="_blank" rel="noopener">See what it shows ↗</a></div>' +
        '</div>' +
      '</div>'
    );
  }

  setStatus('Loading cue sheets…');
  fetch(API_URL, { cache: 'no-cache' }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).then(function (data) {
    var items = (data && Array.isArray(data.items)) ? data.items.slice(0, SHOWN) : [];
    if (!items.length) {
      setStatus('');
      grid.innerHTML = '<div class="server-empty"><p>No cue sheets shared yet.</p>' +
        '<p>The Community plugin arrives with the next Viboplr release — be among the first to publish one.</p></div>';
      return;
    }
    setStatus('');
    grid.innerHTML = items.map(cueCard).join('');
  }).catch(function (e) {
    console.error('Cue sheet load failed:', e);
    setStatus('Couldn’t load cue sheets right now. You can browse them directly at ' +
      '<a href="' + API_BASE + '/" target="_blank" rel="noopener">community.viboplr.com</a>.', true);
  });
})();
