// Viboplr gallery browse pages — live client-side fetch of the plugin/skin
// indexes from GitHub. No build step, no framework. Each page sets
// window.VBPL_GALLERY = "plugins" | "skins" before loading this script.

(function () {
  'use strict';

  var KIND = window.VBPL_GALLERY;
  if (KIND !== 'plugins' && KIND !== 'skins') return;

  // raw.githubusercontent.com serves `access-control-allow-origin: *` (verified),
  // so the index can be fetched directly from the browser. jsDelivr is a
  // longer-cached fallback if raw is unreachable.
  var SOURCES = {
    plugins: [
      'https://raw.githubusercontent.com/outcast1000/viboplr-plugins/main/index.json',
      'https://cdn.jsdelivr.net/gh/outcast1000/viboplr-plugins@main/index.json'
    ],
    skins: [
      'https://raw.githubusercontent.com/outcast1000/viboplr-skins/main/index.json',
      'https://cdn.jsdelivr.net/gh/outcast1000/viboplr-skins@main/index.json'
    ]
  };

  // Skin files are hosted in the skins repo; the app installs a skin by fetching
  // its raw JSON. This base + the index entry's `file` is the exact URL the app
  // itself uses (useSkins.ts GALLERY_BASE_URL), so install_gallery_skin accepts it.
  var SKIN_RAW_BASE = 'https://raw.githubusercontent.com/outcast1000/viboplr-skins/main/';

  var grid = document.getElementById('galleryGrid');
  var statusEl = document.getElementById('galleryStatus');
  var searchEl = document.getElementById('gallerySearch');
  var countEl = document.getElementById('galleryCount');
  // Optional "Recommended" group (present on the plugins page only).
  var recSection = document.getElementById('galleryRecommended');
  var recGrid = document.getElementById('galleryRecommendedGrid');
  var allTitle = document.getElementById('galleryAllTitle');
  if (!grid) return;

  var allItems = [];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function setStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.style.display = msg ? 'block' : 'none';
    statusEl.className = 'gallery-status' + (isError ? ' gallery-status--error' : '');
  }

  function fetchFirst(urls, i) {
    i = i || 0;
    return fetch(urls[i], { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).catch(function (e) {
      if (i + 1 < urls.length) return fetchFirst(urls, i + 1);
      throw e;
    });
  }

  // --- card renderers ---

  // Build a viboplr:// deep link the desktop app understands. The app parses
  // these in App.tsx (install-plugin / install-skin) behind a confirm modal.
  function deepLink(verb, targetUrl) {
    return 'viboplr://' + verb + '?url=' + encodeURIComponent(targetUrl);
  }

  function installButton(verb, targetUrl) {
    if (!targetUrl) return '';
    return '<a class="btn btn-primary btn-sm gallery-install" href="' + esc(deepLink(verb, targetUrl)) + '">' +
      '<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
      '<polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Install in app</a>';
  }

  function textLink(href, label) {
    return '<a class="gallery-source" href="' + esc(href) + '" target="_blank" rel="noopener">' + label + '</a>';
  }

  function pluginCard(p) {
    var rec = p.recommended ? '<span class="gallery-badge">Recommended</span>' : '';
    var repo = repoFromUpdateUrl(p.updateUrl);
    var install = installButton('install-plugin', p.installUrl);
    var links = '';
    if (repo) {
      // blob/HEAD is branch-independent (resolves to the repo's default branch).
      links =
        textLink(repo, 'Source') +
        textLink(repo + '/blob/HEAD/manifest.json', 'Manifest') +
        textLink(repo + '/issues', 'Issues');
    }
    var id = p.id ? '<span class="gallery-card-id">' + esc(p.id) + '</span>' : '';
    return (
      '<div class="gallery-card' + (p.recommended ? ' gallery-card--rec' : '') + '">' +
        '<div class="gallery-card-icon">' + pluginIcon(p) + '</div>' +
        '<div class="gallery-card-body">' +
          '<div class="gallery-card-head"><h3>' + esc(p.name) + '</h3>' + rec + '</div>' +
          id +
          '<p class="gallery-card-desc">' + esc(p.description) + '</p>' +
          '<div class="gallery-card-meta"><span>by ' + esc(p.author) + '</span></div>' +
          '<div class="gallery-card-actions">' + install + '</div>' +
          '<div class="gallery-card-links">' + links + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function pluginIcon(p) {
    if (p.icon && /^[Mm][\d\s.,-]/.test(p.icon)) {
      // SVG path data from the manifest.
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" stroke-linejoin="round"><path d="' + esc(p.icon) + '"/></svg>';
    }
    return '<span class="gallery-card-letter">' + esc((p.name || '?').charAt(0).toUpperCase()) + '</span>';
  }

  function repoFromUpdateUrl(url) {
    if (!url) return null;
    var m = String(url).match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases/);
    return m ? 'https://github.com/' + m[1] : null;
  }

  function skinCard(s) {
    var rec = s.recommended ? '<span class="gallery-badge">Recommended</span>' : '';
    var colors = Array.isArray(s.colors) ? s.colors.slice(0, 4) : [];
    var swatches = colors.map(function (c) {
      return '<span class="gallery-swatch" style="background:' + esc(c) + '"></span>';
    }).join('');
    var bg = colors[0] || '#1a1a2e';
    var fg = colors[2] || '#ffffff';
    var preview =
      '<div class="gallery-skin-preview" style="background:' + esc(bg) + '">' +
        '<span class="gallery-skin-dot" style="background:' + esc(fg) + '"></span>' +
        '<span class="gallery-skin-bar" style="background:' + esc(colors[1] || bg) + '"></span>' +
      '</div>';
    var rawUrl = s.file ? SKIN_RAW_BASE + s.file : null;
    var install = installButton('install-skin', rawUrl);
    var source = rawUrl
      ? '<a class="gallery-source" href="' + esc(rawUrl) + '" target="_blank" rel="noopener">Source</a>'
      : '';
    return (
      '<div class="gallery-card gallery-card--skin' + (s.recommended ? ' gallery-card--rec' : '') + '">' +
        preview +
        '<div class="gallery-card-body">' +
          '<div class="gallery-card-head"><h3>' + esc(s.name) + '</h3>' + rec + '</div>' +
          '<div class="gallery-swatches">' + swatches + '</div>' +
          '<div class="gallery-card-meta"><span>by ' + esc(s.author) + '</span>' +
            '<span class="gallery-meta-pill">' + esc(s.type) + '</span></div>' +
          '<div class="gallery-card-actions">' + install + source + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function setRecVisible(on) {
    if (recSection) recSection.hidden = !on;
    if (allTitle) allTitle.hidden = !on;
  }

  function render(items, searching) {
    var card = KIND === 'plugins' ? pluginCard : skinCard;

    if (!items.length) {
      grid.innerHTML = '';
      if (recGrid) recGrid.innerHTML = '';
      setRecVisible(false);
      setStatus('No ' + KIND + ' match your search.');
      if (countEl) countEl.textContent = '';
      return;
    }
    setStatus('');
    if (countEl) {
      countEl.textContent = items.length + ' ' + (items.length === 1 ? KIND.slice(0, -1) : KIND);
    }

    // Split into a "Recommended" group + the rest, but only when the page has
    // the recommended container, there's at least one recommended item, and the
    // user isn't searching (search shows a single flat result list).
    var recommended = recGrid && !searching ? items.filter(function (it) { return it.recommended; }) : [];
    if (recommended.length) {
      var rest = items.filter(function (it) { return !it.recommended; });
      recGrid.innerHTML = recommended.map(card).join('');
      grid.innerHTML = rest.map(card).join('');
      setRecVisible(true);
    } else {
      if (recGrid) recGrid.innerHTML = '';
      setRecVisible(false);
      grid.innerHTML = items.map(card).join('');
    }
  }

  function sortItems(items) {
    // Recommended first, then alphabetical by name (matches the index order
    // the bot maintains, but we re-sort defensively).
    return items.slice().sort(function (a, b) {
      var r = (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0);
      if (r !== 0) return r;
      return String(a.name).localeCompare(String(b.name));
    });
  }

  function applySearch() {
    var q = (searchEl && searchEl.value || '').trim().toLowerCase();
    if (!q) return render(allItems, false);
    var filtered = allItems.filter(function (it) {
      return (
        String(it.name).toLowerCase().indexOf(q) !== -1 ||
        String(it.author).toLowerCase().indexOf(q) !== -1 ||
        String(it.description || '').toLowerCase().indexOf(q) !== -1
      );
    });
    render(filtered, true);
  }

  // --- boot ---
  setStatus('Loading ' + KIND + '…');
  fetchFirst(SOURCES[KIND]).then(function (index) {
    var list = KIND === 'plugins' ? index.plugins : index.skins;
    if (!Array.isArray(list)) throw new Error('Unexpected index format');
    allItems = sortItems(list);
    render(allItems, false);
    if (searchEl) searchEl.addEventListener('input', applySearch);
  }).catch(function (e) {
    console.error('Gallery load failed:', e);
    setStatus('Couldn’t load the ' + KIND + ' gallery right now. Please try again later.', true);
  });
})();
