// Spotify Browse Plugin for Viboplr
// Opens open.spotify.com in an internal browse window, navigates to configurable
// sections, and scrapes all playlists and their tracks from the rendered DOM.

function activate(api) {
  var activeScrapeHandle = null;
  var scrapeGeneration = 0;
  var pendingSectionInput = "";

  var state = {
    currentView: "home",
    // idle | waiting-login | finding-section | scraping-playlists |
    // scraping-tracks | done | error
    status: "idle",
    playlists: [],
    playlistTracks: {},   // playlistId -> [{ name, artist, album, duration, imageUrl }]
    previousTracks: {},   // playlistId -> tracks from before last refresh
    currentPlaylist: null,
    scrapeProgress: { current: 0, total: 0, name: "" },
    errorMessage: "",
    activeTab: "saved",
    archivedPlaylists: [],
    viewingArchived: false,
    lastLoginCheck: null,
    updatedPlaylistIds: {},
    refreshing: false,
    showBrowserOnRefresh: false,
    autoRefreshHours: 24,
    lastCheckAt: null,
    lastCheckResult: null,
    savedAt: null,
    refreshSummary: "",
    sections: ["Made for You"],
    addingSectionViaTab: false,
  };

  // ---- Helpers ----

  function escapeHtml(s) {
    if (!s) return "";
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function dbg(tag, msg, data) {
    console.log("[spotify-dbg]", tag, msg, data !== undefined ? data : "");
  }

  // ---- Change detection helpers ----

  function tracksChanged(oldTracks, newTracks) {
    if (!oldTracks || oldTracks.length !== newTracks.length) return true;
    var oldSet = {};
    for (var i = 0; i < oldTracks.length; i++) {
      oldSet[oldTracks[i].name + "\0" + oldTracks[i].artist] = true;
    }
    for (var j = 0; j < newTracks.length; j++) {
      if (!oldSet[newTracks[j].name + "\0" + newTracks[j].artist]) return true;
    }
    return false;
  }

  function getDiff(playlistId) {
    var prev = state.previousTracks[playlistId];
    var curr = state.playlistTracks[playlistId];
    if (!prev || !curr) return { added: [], removed: [] };

    var prevSet = {};
    for (var i = 0; i < prev.length; i++) {
      prevSet[prev[i].name + "\0" + prev[i].artist] = prev[i];
    }
    var currSet = {};
    for (var j = 0; j < curr.length; j++) {
      currSet[curr[j].name + "\0" + curr[j].artist] = curr[j];
    }

    var added = [];
    for (var k = 0; k < curr.length; k++) {
      var key = curr[k].name + "\0" + curr[k].artist;
      if (!prevSet[key]) added.push(curr[k]);
    }
    var removed = [];
    for (var m = 0; m < prev.length; m++) {
      var rkey = prev[m].name + "\0" + prev[m].artist;
      if (!currSet[rkey]) removed.push(prev[m]);
    }

    return { added: added, removed: removed };
  }

  function getPlaylistsForSection(sectionName) {
    var result = [];
    for (var i = 0; i < state.playlists.length; i++) {
      if ((state.playlists[i].section || "Playlists") === sectionName) {
        result.push(state.playlists[i]);
      }
    }
    return result;
  }

  function loadArchives() {
    api.storage.get("spotify_browse_archives").then(function(archives) {
      state.archivedPlaylists = archives || [];
      if (state.activeTab === "saved") render();
    }).catch(function(err) {
      console.error("Failed to load archives:", err);
      state.archivedPlaylists = [];
    });
  }

  function saveArchives() {
    api.storage.set("spotify_browse_archives", state.archivedPlaylists).catch(console.error);
  }

  function archivePlaylist(pl) {
    var tracks = state.playlistTracks[pl.id] || [];
    var now = new Date();
    var entry = {
      id: pl.id + ":" + now.getTime(),
      spotifyId: pl.id,
      name: pl.name,
      section: pl.section || null,
      imageUrl: pl.imageUrl || null,
      archivedAt: now.toISOString(),
      trackCount: tracks.length,
      tracks: [],
    };
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      entry.tracks.push({
        name: t.name || "",
        artist: t.artist || "",
        album: t.album || "",
        duration: t.duration || "",
        imageUrl: t.imageUrl || null,
      });
    }
    state.archivedPlaylists.unshift(entry);
    saveArchives();
    loadArchives();
    api.ui.showNotification("Archived: " + pl.name);
  }

  function djb2Hash(str) {
    var hash = 5381;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash & 0xFFFFFFFF;
    }
    var hex = (hash >>> 0).toString(16);
    while (hex.length < 8) hex = "0" + hex;
    return hex;
  }

  function cacheAllImages() {
    var promises = [];
    var playlists = state.playlists;

    for (var pi = 0; pi < playlists.length; pi++) {
      (function(pl) {
        if (pl.imageUrl && pl.imageUrl.indexOf("http") === 0) {
          promises.push(
            api.informationTypes.invoke("plugin_cache_image", {
              pluginId: "spotify-browse",
              subdir: pl.id,
              filename: "cover.jpg",
              url: pl.imageUrl,
            }).then(function(path) {
              pl.imageUrl = path;
            }).catch(function(e) {
              console.error("Failed to cache playlist cover:", e);
            })
          );
        }
        var tracks = state.playlistTracks[pl.id] || [];
        for (var ti = 0; ti < tracks.length; ti++) {
          (function(track) {
            if (track.imageUrl && track.imageUrl.indexOf("http") === 0) {
              var hash = djb2Hash(track.name + " - " + track.artist);
              promises.push(
                api.informationTypes.invoke("plugin_cache_image", {
                  pluginId: "spotify-browse",
                  subdir: pl.id,
                  filename: hash + ".jpg",
                  url: track.imageUrl,
                }).then(function(path) {
                  track.imageUrl = path;
                }).catch(function(e) {
                  console.error("Failed to cache track image:", e);
                })
              );
            }
          })(tracks[ti]);
        }
      })(playlists[pi]);
    }

    if (promises.length > 0) {
      Promise.all(promises).then(function() {
        saveState();
        render();
      }).catch(function() {
        saveState();
      });
    }
  }

  function saveState() {
    state.savedAt = Date.now();
    api.storage.set("spotify_browse_state", {
      playlists: state.playlists,
      playlistTracks: state.playlistTracks,
      previousTracks: state.previousTracks,
      savedAt: state.savedAt,
    }).catch(console.error);
  }

  function savePreferences() {
    api.storage.set("spotify_browse_preferences", {
      showBrowserOnRefresh: state.showBrowserOnRefresh,
      autoRefreshHours: state.autoRefreshHours,
      lastCheckAt: state.lastCheckAt,
      lastCheckResult: state.lastCheckResult,
    }).catch(console.error);
  }

  function formatRelativeTime(isoStr) {
    if (!isoStr) return "";
    var diff = Date.now() - new Date(isoStr).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    var days = Math.floor(hrs / 24);
    return days + "d ago";
  }

  function recordCheckResult(playlists, errors) {
    state.lastCheckAt = new Date().toISOString();
    state.lastCheckResult = playlists + " playlists";
    if (errors > 0) state.lastCheckResult += ", " + errors + " error" + (errors > 1 ? "s" : "");
    savePreferences();
  }

  // ---- Render ----

  function render() {
    if (state.currentView === "playlist") { renderPlaylist(); return; }
    renderHome();
  }

  function getStatusText() {
    if (state.status === "waiting-login") return "Waiting for login…";
    if (state.status === "finding-section") return state.refreshSummary || "Finding section…";
    if (state.status === "scraping-playlists") return "Grabbing playlists…";
    if (state.status === "scraping-tracks") {
      var lbl = "Grabbing tracks";
      if (state.scrapeProgress.name) lbl += ": " + state.scrapeProgress.name;
      if (state.scrapeProgress.total > 0) lbl += " (" + state.scrapeProgress.current + "/" + state.scrapeProgress.total + ")";
      return lbl + "…";
    }
    if (state.status === "error") return state.errorMessage;
    if (state.refreshSummary) return state.refreshSummary;
    return "";
  }

  function buildHeader() {
    var headerChildren = [
      { type: "text", content: "<b style='font-size:var(--fs-sm)'>Spotify</b>" },
    ];

    var isActive = state.status === "waiting-login" || state.status === "finding-section" || state.status === "scraping-playlists" || state.status === "scraping-tracks";

    if (state.status === "idle") {
      headerChildren.push({ type: "button", label: "Open Spotify", action: "open-spotify", style: { "font-size": "var(--fs-xs)", "padding": "3px 10px" } });
    } else if (isActive) {
      headerChildren.push({ type: "button", label: "Cancel", action: "cancel", variant: "secondary", style: { "font-size": "var(--fs-xs)", "padding": "3px 10px" } });
    } else {
      headerChildren.push({ type: "button", label: "Refresh", action: "manual-refresh", variant: "secondary", style: { "font-size": "var(--fs-xs)", "padding": "3px 10px" } });
      headerChildren.push({ type: "button", label: "Open Browser", action: "open-browser", variant: "secondary", style: { "font-size": "var(--fs-xs)", "padding": "3px 10px" } });
    }

    if (state.lastCheckAt && !isActive) {
      var relTime = formatRelativeTime(state.lastCheckAt);
      var checkInfo = relTime;
      if (state.lastCheckResult) checkInfo += " — " + state.lastCheckResult;
      headerChildren.push({ type: "text", content: "<span style='font-size:var(--fs-2xs);color:var(--text-tertiary);white-space:nowrap'>" + escapeHtml(checkInfo) + "</span>" });
    }

    var header = [
      { type: "layout", direction: "horizontal", children: headerChildren },
    ];

    var statusText = getStatusText();
    if (statusText) {
      var color = state.status === "error" ? "var(--error)" : "var(--text-secondary)";
      header.push({ type: "text", content: "<p style='margin:0;font-size:var(--fs-xs);color:" + color + "'>" + escapeHtml(statusText) + "</p>" });
    }

    return header;
  }

  function buildTabs() {
    var tabs = [];
    tabs.push({ id: "saved", label: "Archived Playlists", count: state.archivedPlaylists.length || undefined });
    for (var i = 0; i < state.sections.length; i++) {
      var sec = state.sections[i];
      var secPlaylists = getPlaylistsForSection(sec);
      tabs.push({ id: "section:" + sec, label: sec, count: secPlaylists.length || undefined });
    }
    tabs.push({ id: "__add__", label: "+" });
    return tabs;
  }

  function buildPlaylistCards(playlists) {
    var cards = [];
    for (var pi = 0; pi < playlists.length; pi++) {
      var sp = playlists[pi];
      var ts = state.playlistTracks[sp.id];
      var sub = ts ? ts.length + " tracks" : (sp.description || "");
      if (state.updatedPlaylistIds[sp.id]) {
        var diff = getDiff(sp.id);
        var diffParts = [];
        if (diff.added.length > 0) diffParts.push("+" + diff.added.length);
        if (diff.removed.length > 0) diffParts.push("-" + diff.removed.length);
        var diffStr = diffParts.length > 0 ? " (" + diffParts.join(", ") + ")" : "";
        sub = "• Updated" + diffStr + " — " + sub;
      }
      var cardTracks = [];
      if (ts) {
        for (var ti = 0; ti < ts.length; ti++) {
          cardTracks.push({
            title: ts[ti].name || "",
            artistName: ts[ti].artist || null,
            albumName: ts[ti].album || null,
          });
        }
      }
      cards.push({
        id: "playlist:" + sp.id,
        title: sp.name,
        subtitle: sub,
        imageUrl: sp.imageUrl,
        action: "view-playlist",
        targetKind: "playlist",
        tracks: cardTracks,
        contextMenuActions: [
          { id: "play-playlist", label: "Play" },
          { id: "enqueue-playlist", label: "Enqueue" },
          { id: "view-playlist", label: "View / Edit" },
          { id: "sep", label: "", separator: true },
          { id: "archive-playlist", label: "Archive" },
          { id: "save-playlist-ctx", label: "Save to Playlists" },
        ],
      });
    }
    return cards;
  }

  function renderHome() {
    api.ui.setBadge("spotify", null);
    var ch = [];
    var isActive = state.status === "waiting-login" || state.status === "finding-section" || state.status === "scraping-playlists" || state.status === "scraping-tracks";

    if (state.activeTab === "saved") {
      if (state.archivedPlaylists.length === 0) {
        ch.push({ type: "text", content: "<p style='opacity:0.5'>No archived playlists yet. Use the Archive option on a playlist to snapshot it here.</p>" });
      } else {
        var archivedCards = [];
        for (var ai = 0; ai < state.archivedPlaylists.length; ai++) {
          var ap = state.archivedPlaylists[ai];
          var archDate = ap.archivedAt ? new Date(ap.archivedAt) : null;
          var dateSub = archDate ? archDate.toLocaleDateString() : "";
          var sub = ap.trackCount + " tracks";
          if (dateSub) sub += " — " + dateSub;
          archivedCards.push({
            id: "archived:" + ai,
            title: ap.name,
            subtitle: sub,
            imageUrl: ap.imageUrl || undefined,
            action: "view-archived",
            targetKind: "playlist",
            contextMenuActions: [
              { id: "play-archived", label: "Play" },
              { id: "enqueue-archived", label: "Enqueue" },
              { id: "sep", label: "", separator: true },
              { id: "delete-archived", label: "Delete" },
            ],
          });
        }
        ch.push({ type: "card-grid", items: archivedCards });
      }
    } else if (state.activeTab.indexOf("section:") === 0) {
      var sectionName = state.activeTab.substring(8);
      var secPlaylists = getPlaylistsForSection(sectionName);
      if (!isActive) {
        var sectionActions = [
          { type: "button", label: "Remove Section", action: "remove-section-tab", variant: "secondary", style: { "font-size": "var(--fs-xs)", "padding": "3px 10px" }, data: { section: sectionName } },
        ];
        if (state.status !== "idle") {
          sectionActions.unshift(
            { type: "button", label: "Refresh " + sectionName, action: "refresh-section", variant: "secondary", disabled: state.refreshing, style: { "font-size": "var(--fs-xs)", "padding": "3px 10px" }, data: { section: sectionName } }
          );
        }
        ch.push({
          type: "layout", direction: "horizontal", style: { "margin-bottom": "8px", "gap": "8px" },
          children: sectionActions,
        });
      }
      if (secPlaylists.length === 0 && state.status === "idle") {
        ch.push({ type: "text", content: "<p style='opacity:0.5'>No playlists found for this section. Click <b>Open Spotify</b> or <b>Refresh</b> to scrape.</p>" });
      } else if (secPlaylists.length > 0) {
        ch.push({ type: "card-grid", items: buildPlaylistCards(secPlaylists) });
      }
    }

    var body = [
      { type: "tabs", activeTab: state.activeTab, action: "switch-tab", tabs: buildTabs() },
    ];

    if (state.addingSectionViaTab) {
      body.push({
        type: "layout", direction: "horizontal", style: { "gap": "8px", "margin": "8px 0", "align-items": "center" },
        children: [
          { type: "text-input", placeholder: "Section name (e.g. Your Top Mixes)", action: "section-tab-input" },
          { type: "button", label: "Add", action: "add-section-tab", variant: "primary", style: { "font-size": "var(--fs-xs)", "padding": "3px 10px" } },
          { type: "button", label: "Cancel", action: "cancel-add-section", variant: "secondary", style: { "font-size": "var(--fs-xs)", "padding": "3px 10px" } },
        ],
      });
    }

    body.push({ type: "layout", direction: "vertical", children: ch });

    api.ui.setViewData("spotify", {
      type: "layout", direction: "vertical", children: buildHeader().concat(body)
    });
  }

  function renderPlaylist() {
    var pl = state.currentPlaylist;
    if (!pl) return;
    var tracks = state.playlistTracks[pl.id] || [];
    var ch = [
      { type: "button", label: "← Back", action: "go-home" },
    ];
    if (!state.viewingArchived) {
      ch.push({ type: "button", label: "Archive", action: "archive-current", variant: "accent" });
      ch.push({ type: "button", label: "Save to Playlists", action: "save-playlist", variant: "secondary" });
    }
    ch.push({ type: "spacer" });
    ch.push({ type: "text", content: "<h2>" + escapeHtml(pl.name) + "</h2>" });
    ch.push({ type: "text", content: "<p style='opacity:0.6'>" + tracks.length + " tracks</p>" });
    if (pl.imageUrl) {
      ch.push({ type: "card-grid", columns: 3, items: [{ id: "cover", title: "", imageUrl: pl.imageUrl }] });
      ch.push({ type: "spacer" });
    }
    if (tracks.length > 0) {
      var diff = getDiff(pl.id);
      var addedSet = {};
      for (var ai = 0; ai < diff.added.length; ai++) {
        addedSet[diff.added[ai].name + "\0" + diff.added[ai].artist] = true;
      }

      var items = [];
      for (var i = 0; i < tracks.length; i++) {
        var t = tracks[i];
        var isAdded = addedSet[t.name + "\0" + t.artist];
        var item = {
          id: "track:" + i,
          title: t.name || "Unknown",
          subtitle: (t.artist || "Unknown") + (t.album ? " — " + t.album : ""),
          imageUrl: t.imageUrl || undefined,
          duration: t.duration || "",
        };
        if (isAdded) {
          item.style = { "border-left": "3px solid var(--success)", "padding-left": "8px" };
        }
        items.push(item);
      }
      ch.push({ type: "track-row-list", items: items });

      // Show removed tracks at bottom
      if (diff.removed.length > 0) {
        ch.push({ type: "spacer" });
        ch.push({ type: "text", content: "<p style='font-size:var(--fs-xs);color:var(--text-secondary);margin:0'>Removed tracks</p>" });
        var removedItems = [];
        for (var ri = 0; ri < diff.removed.length; ri++) {
          var rt = diff.removed[ri];
          removedItems.push({
            id: "removed:" + ri,
            title: rt.name || "Unknown",
            subtitle: (rt.artist || "Unknown") + (rt.album ? " — " + rt.album : ""),
            imageUrl: rt.imageUrl || undefined,
            duration: rt.duration || "",
            style: { "text-decoration": "line-through", "opacity": "0.5" },
          });
        }
        ch.push({ type: "track-row-list", items: removedItems });
      }
    } else {
      ch.push({ type: "text", content: "<p style='opacity:0.5'>No tracks scraped</p>" });
    }
    api.ui.setViewData("spotify", { type: "layout", direction: "vertical", children: ch });
  }

  function renderSettings() {
    var ch = [];

    ch.push({ type: "text", content: "<p style='font-size:var(--fs-sm);font-weight:600;margin:0 0 8px 0'>Sections to Monitor</p>" });
    ch.push({ type: "text", content: "<p style='font-size:var(--fs-xs);color:var(--text-secondary);margin:0 0 8px 0'>Spotify browse sections to scrape for playlists (e.g. \"Made for You\", \"Your Top Mixes\")</p>" });

    for (var i = 0; i < state.sections.length; i++) {
      ch.push({
        type: "layout", direction: "horizontal", style: { "align-items": "center", "gap": "8px", "margin-bottom": "4px" },
        children: [
          { type: "text", content: "<span style='font-size:var(--fs-xs)'>" + escapeHtml(state.sections[i]) + "</span>" },
          { type: "button", label: "×", action: "remove-section", variant: "secondary", style: { "font-size": "var(--fs-xs)", "padding": "2px 8px", "min-width": "auto" }, data: { index: i } },
        ],
      });
    }

    ch.push({
      type: "layout", direction: "horizontal", style: { "gap": "8px", "margin-top": "8px" },
      children: [
        { type: "text-input", placeholder: "Section name...", action: "section-input" },
        { type: "button", label: "Add", action: "add-section", variant: "secondary", style: { "font-size": "var(--fs-xs)", "padding": "3px 10px" } },
      ],
    });

    ch.push({ type: "spacer" });

    ch.push({
      type: "select", label: "Auto-refresh interval", action: "set-auto-refresh",
      value: "" + state.autoRefreshHours,
      options: [
        { value: "0", label: "Off" },
        { value: "6", label: "Every 6 hours" },
        { value: "12", label: "Every 12 hours" },
        { value: "24", label: "Every 24 hours" },
        { value: "48", label: "Every 2 days" },
        { value: "168", label: "Every week" },
      ],
    });

    ch.push({ type: "toggle", label: "Show browser window during refresh", checked: state.showBrowserOnRefresh, action: "toggle-show-browser-pref" });

    api.ui.setViewData("spotify-settings", {
      type: "layout", direction: "vertical", children: ch,
    });
  }

  // ---- Injected scripts (plain strings for eval) ----

  var DBG_HELPER =
    'function _dbg(tag,msg,data){' +
      'console.log("[spotify-dbg]",tag,msg,data)' +
    '}';

  var IMG_HELPER =
    'function bestImg(el){' +
      'var imgs=el.querySelectorAll("img");' +
      'for(var k=0;k<imgs.length;k++){' +
        'var s=imgs[k].currentSrc||imgs[k].src||"";' +
        'if(s&&s.indexOf("data:")!==0&&s.indexOf("blob:")!==0)return s;' +
        'var ss=imgs[k].getAttribute("srcset");' +
        'if(ss){var parts=ss.split(",");for(var p=parts.length-1;p>=0;p--){' +
          'var u=parts[p].trim().split(/\\s+/)[0];if(u)return u;' +
        '}}' +
        'var ds=imgs[k].getAttribute("data-src");' +
        'if(ds)return ds;' +
      '}' +
      'var bgs=el.querySelectorAll("[style]");' +
      'for(var b=0;b<bgs.length;b++){' +
        'var bg=bgs[b].style.backgroundImage||"";' +
        'var bm=bg.match(/url\\([\\"\\\']*([^\\"\\\'\\)]+)/);' +
        'if(bm&&bm[1])return bm[1];' +
      '}' +
      'return null;' +
    '}';

  var SCRIPT_CHECK_LOGIN = '(function(){' +
    'console.log("[viboplr-login] script start");' +
    'try{' +
    'function qs(sel){try{return document.querySelector(sel)}catch(e){console.log("[viboplr-login] bad selector: "+sel+" err: "+e);return null}}' +
    'function qsa(sel){try{return document.querySelectorAll(sel)}catch(e){console.log("[viboplr-login] bad selector: "+sel+" err: "+e);return[]}}' +
    'var signals={};' +
    'signals.userWidget=!!qs("[data-testid=\\"user-widget-link\\"]");' +
    'signals.userBox=!!qs(".main-userWidget-box");' +
    'signals.avatar=!!qs("img[alt*=\\"avatar\\"], img[alt*=\\"profile\\"]");' +
    'signals.accountLink=!!qs("a[href*=\\"/account\\"], button[data-testid=\\"user-widget-link\\"]");' +
    'signals.libraryBtn=!!qs("[aria-label=\\"Your Library\\"], [aria-label*=\\"library\\"]");' +
    'signals.createPlaylist=!!qs("[aria-label*=\\"Create\\"]");' +
    'signals.loginBtn=!!qs("[data-testid=\\"login-button\\"]");' +
    'signals.signupBtn=!!qs("[data-testid=\\"signup-button\\"], a[href*=\\"signup\\"]");' +
    'signals.loginLink=!!qs("a[href*=\\"/login\\"]");' +
    'console.log("[viboplr-login] signals:",JSON.stringify(signals));' +
    'var pos=signals.userWidget||signals.userBox||signals.avatar||signals.accountLink||signals.libraryBtn||signals.createPlaylist;' +
    'var neg=signals.loginBtn||signals.signupBtn||signals.loginLink;' +
    'var ok=pos&&!neg;' +
    'var pageDump=null;' +
    'if(!pos&&!neg){' +
      'var btns=qsa("button");' +
      'var btnTexts=[];for(var b=0;b<Math.min(btns.length,20);b++){btnTexts.push((btns[b].textContent||"").trim().substring(0,40)+"["+(btns[b].getAttribute("data-testid")||btns[b].getAttribute("aria-label")||"")+"]")}' +
      'var navs=qsa("nav a, nav button");' +
      'var navTexts=[];for(var n=0;n<Math.min(navs.length,20);n++){navTexts.push((navs[n].textContent||"").trim().substring(0,40))}' +
      'var testids=qsa("[data-testid]");' +
      'var tidList=[];for(var t=0;t<Math.min(testids.length,40);t++){tidList.push(testids[t].getAttribute("data-testid"))}' +
      'pageDump={buttons:btnTexts,navItems:navTexts,testids:tidList,bodyClasses:document.body.className,title:document.title};' +
      'console.log("[viboplr-login] NO CLEAR SIGNAL page dump:",JSON.stringify(pageDump));' +
    '}' +
    'console.log("[viboplr-login] result: loggedIn="+ok+" pos="+pos+" neg="+neg);' +
    'window.__viboplr.send("login-check",{loggedIn:ok,signals:signals,url:location.href,pageDump:pageDump});' +
    '}catch(e){' +
      'console.error("[viboplr-login] CAUGHT ERROR:",e,""+e,e.stack);' +
      'try{window.__viboplr.send("login-check",{loggedIn:false,error:""+e})}catch(e2){console.error("[viboplr-login] send also failed:",e2)}' +
    '}})()';

  // Parameterized section finder — replaces hardcoded SCRIPT_FIND_MADE_FOR_YOU
  function scriptFindSection(sectionName) {
    var lower = sectionName.toLowerCase().replace(/'/g, "\\'");
    return '(function(){try{' +
      DBG_HELPER +
      'var target="' + lower + '";' +
      'var links=document.querySelectorAll("a");' +
      'var linkTexts=[];for(var x=0;x<Math.min(links.length,30);x++){linkTexts.push(links[x].textContent.trim().substring(0,60))}' +
      '_dbg("section","searching "+links.length+" links for \\""+target+"\\"",linkTexts);' +
      'for(var i=0;i<links.length;i++){' +
        'var txt=(links[i].textContent||"").trim().toLowerCase();' +
        'if(txt===target||txt.indexOf(target)!==-1){' +
          'var href=links[i].getAttribute("href")||"";' +
          '_dbg("section","FOUND via link",{index:i,text:txt,href:href});' +
          'links[i].click();' +
          'window.__viboplr.send("section-found",{href:href});' +
          'return;' +
        '}' +
      '}' +
      'var headings=document.querySelectorAll("h2, h3, span, p");' +
      '_dbg("section","checking "+headings.length+" headings/spans");' +
      'for(var j=0;j<headings.length;j++){' +
        'var h=headings[j];' +
        'var ht=(h.textContent||"").trim().toLowerCase();' +
        'if(ht===target||ht.indexOf(target)!==-1){' +
          'var parent=h.closest("a");' +
          'if(parent){' +
            '_dbg("section","FOUND via heading>a",{tag:h.tagName,text:ht,href:parent.getAttribute("href")});' +
            'parent.click();' +
            'window.__viboplr.send("section-found",{href:parent.getAttribute("href")||""});' +
            'return;' +
          '}' +
          '_dbg("section","FOUND via heading click",{tag:h.tagName,text:ht});' +
          'h.click();' +
          'window.__viboplr.send("section-found",{href:"clicked-heading"});' +
          'return;' +
        '}' +
      '}' +
      '_dbg("section","NOT FOUND: \\""+target+"\\"",{url:location.href});' +
      'window.__viboplr.send("section-not-found",{});' +
      '}catch(e){window.__viboplr.send("error",{message:"find section: "+e})}})()';
  }

  var SCRIPT_SCRAPE_PLAYLISTS = '(function(){try{' +
    DBG_HELPER +
    IMG_HELPER +
    'var out=[];var seen={};' +
    '_dbg("playlists","starting scrape",{url:location.href});' +
    // Strategy 1: card-based layout (data-testid="card")
    'var cards=document.querySelectorAll("div[data-testid=\\"card\\"]");' +
    '_dbg("playlists","strategy1: cards",{count:cards.length});' +
    'for(var i=0;i<cards.length;i++){' +
      'var c=cards[i];' +
      'var a=c.querySelector("a[href*=\\"/playlist/\\"]");' +
      'if(!a){continue}' +
      'var m=(a.getAttribute("href")||"").match(/\\/playlist\\/([a-zA-Z0-9]+)/);' +
      'if(!m||seen[m[1]])continue;seen[m[1]]=1;' +
      'var ne=c.querySelector("[data-testid=\\"card-title\\"]")||c.querySelector("p")||c.querySelector("span");' +
      'var nm=ne?ne.textContent.trim():"";' +
      'var de=c.querySelector("[data-testid=\\"card-subtitle\\"]");' +
      'var ds=de?de.textContent.trim():"";' +
      'var imgUrl=bestImg(c);' +
      '_dbg("playlists","card["+i+"] found",{id:m[1],name:nm,desc:ds,hasImg:!!imgUrl});' +
      'if(nm)out.push({id:m[1],name:nm,description:ds,imageUrl:imgUrl,uri:"spotify:playlist:"+m[1]});' +
    '}' +
    // Strategy 2: row-based layout (role="row" containing playlist links)
    'var rows=document.querySelectorAll("[role=\\"row\\"]");' +
    '_dbg("playlists","strategy2: rows",{count:rows.length});' +
    'for(var ri=0;ri<rows.length;ri++){' +
      'var rw=rows[ri];' +
      'var ra=rw.querySelector("a[href*=\\"/playlist/\\"]");' +
      'if(!ra)continue;' +
      'var rm=(ra.getAttribute("href")||"").match(/\\/playlist\\/([a-zA-Z0-9]+)/);' +
      'if(!rm||seen[rm[1]])continue;seen[rm[1]]=1;' +
      'var rne=ra.querySelector("div")||ra.querySelector("span")||ra;' +
      'var rnm=rne?rne.textContent.trim():"";' +
      'var rds="";var rsub=rw.querySelector("span:not(:first-child)");' +
      'if(rsub)rds=rsub.textContent.trim();' +
      'var rimg=bestImg(rw);' +
      '_dbg("playlists","row["+ri+"] found",{id:rm[1],name:rnm,desc:rds,hasImg:!!rimg});' +
      'if(rnm)out.push({id:rm[1],name:rnm,description:rds,imageUrl:rimg,uri:"spotify:playlist:"+rm[1]});' +
    '}' +
    // Strategy 3: any remaining playlist links not caught above
    'function findImgContainer(el){' +
      'var node=el;' +
      'for(var up=0;up<6&&node;up++){' +
        'var img=bestImg(node);' +
        'if(img)return img;' +
        'node=node.parentElement;' +
      '}' +
      'return null;' +
    '}' +
    'var allLinks=document.querySelectorAll("a[href*=\\"/playlist/\\"]");' +
    '_dbg("playlists","strategy3: remaining links",{count:allLinks.length,alreadySeen:Object.keys(seen).length});' +
    'for(var li=0;li<allLinks.length;li++){' +
      'var la=allLinks[li];' +
      'var lm=(la.getAttribute("href")||"").match(/\\/playlist\\/([a-zA-Z0-9]+)/);' +
      'if(!lm||seen[lm[1]])continue;seen[lm[1]]=1;' +
      'var lnm=la.textContent.trim();' +
      'var limg=findImgContainer(la);' +
      '_dbg("playlists","link["+li+"] found",{id:lm[1],name:lnm,href:la.getAttribute("href"),hasImg:!!limg});' +
      'if(lnm)out.push({id:lm[1],name:lnm,description:"",imageUrl:limg,uri:"spotify:playlist:"+lm[1]});' +
    '}' +
    '_dbg("playlists","DONE",{total:out.length,names:out.map(function(p){return p.name})});' +
    'window.__viboplr.send("playlists",out);' +
    '}catch(e){window.__viboplr.send("error",{message:""+e})}})()';

  function scriptNavigatePlaylist(id) {
    return '(function(){' +
      DBG_HELPER +
      '_dbg("tracks","navigating to /playlist/' + id + '");' +
      'window.location.href="/playlist/' + id + '"' +
    '})()';
  }

  function scriptScrollThenScrape(playlistId, gen) {
    return '(function(){' +
      DBG_HELPER +
      IMG_HELPER +
      'var _gen=' + gen + ';' +
      '_dbg("tracks","=== START scrape for ' + playlistId + '",{url:location.href,gen:_gen});' +
      // Scope to main content area to avoid sidebar rows
      'var mainEl=document.querySelector("[data-testid=\\"playlist-tracklist\\"]")' +
        '||document.querySelector("main")||document;' +
      'var sc=mainEl.closest?mainEl:document.scrollingElement;' +
      'if(mainEl.scrollHeight>mainEl.clientHeight){sc=mainEl}' +
      'else{sc=document.querySelector("main")||document.scrollingElement}' +
      '_dbg("tracks","scroll container",{tag:sc.tagName,testid:sc.getAttribute&&sc.getAttribute("data-testid"),scrollH:sc.scrollHeight});' +
      'var ph=0,stable=0,n=0;' +
      'function tick(){' +
        'sc.scrollTop=sc.scrollHeight;n++;' +
        'if(sc.scrollHeight===ph){stable++}else{stable=0}' +
        'ph=sc.scrollHeight;' +
        'if(n%10===0)_dbg("tracks","scrolling",{tick:n,stable:stable,scrollH:sc.scrollHeight});' +
        'if(stable>=3||n>=50){_dbg("tracks","scroll done",{ticks:n,finalH:sc.scrollHeight});scrape()}else{setTimeout(tick,800)}' +
      '}' +
      'function scrape(){try{' +
        'var out=[];var skipped=0;' +
        // Query rows only inside main content, not sidebar
        'var scope=document.querySelector("[data-testid=\\"playlist-tracklist\\"]")||document.querySelector("main")||document;' +
        'var rows=scope.querySelectorAll("[role=\\"row\\"]");' +
        '_dbg("tracks","rows found (scoped to main)",{count:rows.length,scopeTag:scope.tagName,scopeTestid:scope.getAttribute&&scope.getAttribute("data-testid")});' +
        'for(var d=0;d<Math.min(rows.length,3);d++){' +
          'var dr=rows[d];' +
          'var gcells=dr.querySelectorAll("[role=\\"gridcell\\"]");' +
          'var cellInfo=[];for(var dc=0;dc<gcells.length;dc++){cellInfo.push({idx:dc,text:gcells[dc].textContent.trim().substring(0,80),childCount:gcells[dc].children.length})}' +
          '_dbg("tracks","row["+d+"] structure",{' +
            'gridcells:gcells.length,' +
            'cells:cellInfo,' +
            'hasTrackLink:!!dr.querySelector("a[href*=\\"/track/\\"]"),' +
            'hasArtistLink:!!dr.querySelector("a[href*=\\"/artist/\\"]"),' +
            'hasAlbumLink:!!dr.querySelector("a[href*=\\"/album/\\"]"),' +
            'hasInternalTrackLink:!!dr.querySelector("[data-testid=\\"internal-track-link\\"]"),' +
            'hasDuration:!!dr.querySelector("[data-testid=\\"tracklist-duration\\"]"),' +
            'outerHTML:dr.outerHTML.substring(0,300)' +
          '});' +
        '}' +
        'for(var i=0;i<rows.length;i++){var r=rows[i];' +
          'var ne=r.querySelector("[data-testid=\\"internal-track-link\\"] div")' +
            '||r.querySelector("a[href*=\\"/track/\\"]")' +
            '||r.querySelector("[data-testid=\\"tracklist-row\\"] a");' +
          'var nameSource="testid|track-link|tracklist-a";' +
          'if(!ne){var cells=r.querySelectorAll("[role=\\"gridcell\\"]");' +
            'if(cells.length>=2){ne=cells[1].querySelector("a")||cells[1].querySelector("div>div>span")||cells[1].querySelector("span");nameSource="gridcell[1]"}}' +
          'var nm=ne?ne.textContent.trim():"";' +
          'if(!nm){' +
            'if(i<5)_dbg("tracks","row["+i+"] SKIPPED no name",{' +
              'gridcells:r.querySelectorAll("[role=\\"gridcell\\"]").length,' +
              'allText:r.textContent.trim().substring(0,120),' +
              'innerHTML:r.innerHTML.substring(0,300)' +
            '});' +
            'skipped++;continue}' +
          'var aLinks=r.querySelectorAll("a[href*=\\"/artist/\\"]");' +
          'var arts=[];for(var j=0;j<aLinks.length;j++){var at=aLinks[j].textContent.trim();if(at&&arts.indexOf(at)===-1)arts.push(at)}' +
          'var artistSource="artist-links("+aLinks.length+")";' +
          'if(!arts.length){var cells2=r.querySelectorAll("[role=\\"gridcell\\"]");' +
            'if(cells2.length>=2){var spans=cells2[1].querySelectorAll("span");' +
              'for(var s=0;s<spans.length;s++){var st=spans[s].textContent.trim();' +
                'if(st&&st!==nm&&st.indexOf(nm)===-1&&nm.indexOf(st)===-1){arts.push(st);artistSource="gridcell-span";break}}}}' +
          'var alEl=r.querySelector("a[href*=\\"/album/\\"]");' +
          'var al=alEl?alEl.textContent.trim():"";' +
          'var du=r.querySelector("[data-testid=\\"tracklist-duration\\"]");' +
          'var durSource="testid";' +
          'if(!du){var cells3=r.querySelectorAll("[role=\\"gridcell\\"]");' +
            'if(cells3.length>0){du=cells3[cells3.length-1];durSource="last-gridcell"}}' +
          'var dur="";if(du){var dt=du.textContent.trim();if(/^\\d+:\\d{2}$/.test(dt))dur=dt}' +
          'var imgUrl=bestImg(r);' +
          'if(i<5)_dbg("tracks","row["+i+"] parsed",{name:nm,nameSource:nameSource,artist:arts.join(", "),artistSource:artistSource,album:al,dur:dur,durSource:durSource,hasImg:!!imgUrl});' +
          'out.push({name:nm,artist:arts.join(", "),album:al,duration:dur,imageUrl:imgUrl})' +
        '}' +
        '_dbg("tracks","=== DONE ' + playlistId + '",{parsed:out.length,skipped:skipped,total:rows.length,gen:_gen});' +
        'window.__viboplr.send("tracks",{playlistId:"' + playlistId + '",tracks:out,gen:_gen});' +
      '}catch(e){_dbg("tracks","ERROR",{error:""+e});window.__viboplr.send("tracks",{playlistId:"' + playlistId + '",tracks:[],error:""+e,gen:_gen})}}' +
      'tick()' +
    '})()';
  }

  // ---- Consolidated scrape function ----

  function performScrape(showProgress, visible, sectionsOverride) {
    var sectionsToScrape = sectionsOverride || state.sections;
    return new Promise(function(resolve, reject) {
      var allPlaylists = [];
      var allTracks = {};
      var seenIds = {};
      var failedSections = [];
      var handle = null;
      var gen = ++scrapeGeneration;

      function done(val) {
        if (handle) { handle.close().catch(console.error); handle = null; }
        activeScrapeHandle = null;
        resolve(val);
      }

      function fail(err) {
        if (handle) { handle.close().catch(console.error); handle = null; }
        activeScrapeHandle = null;
        reject(err);
      }

      api.network.openBrowseWindow("https://open.spotify.com", {
        title: "Spotify",
        width: 1200,
        height: 800,
        visible: !!visible,
      }).then(function(h) {
        handle = h;
        activeScrapeHandle = h;
        var loginRetries = 0;
        var loginTimer = null;

        // Single message handler -- routes to current phase handler
        var currentHandler = null;
        function setHandler(fn) {
          currentHandler = fn;
        }
        h.onMessage(function(msg) {
          if (msg.type === "window-closed") { done(null); return; }
          if (currentHandler) currentHandler(msg);
        });

        // Phase 1: Wait for login
        if (showProgress) { state.status = "waiting-login"; render(); }

        function checkLogin() {
          loginRetries++;
          if (loginRetries > 10) {
            if (loginTimer) { clearInterval(loginTimer); loginTimer = null; }
            done(null);
            return;
          }
          h.eval(SCRIPT_CHECK_LOGIN);
        }

        setHandler(function(msg) {
          if (msg.type === "login-check" && msg.data && msg.data.loggedIn) {
            if (loginTimer) { clearInterval(loginTimer); loginTimer = null; }
            scrapeSections();
          }
        });

        loginTimer = setInterval(checkLogin, 3000);
        setTimeout(checkLogin, 3000);

        // Phase 2: Iterate over sections
        function scrapeSections() {
          var sectionIdx = 0;

          function nextSection() {
            if (gen !== scrapeGeneration) { done(null); return; }
            if (sectionIdx >= sectionsToScrape.length) {
              scrapeAllTracks();
              return;
            }
            var sectionName = sectionsToScrape[sectionIdx];
            sectionIdx++;

            if (showProgress) {
              state.status = "finding-section";
              state.refreshSummary = "Finding: " + sectionName;
              render();
            }

            // Navigate to home first (except for the first section where we're already there)
            if (sectionIdx > 1) {
              h.eval('window.location.href="https://open.spotify.com"');
            }

            // Wait for home page to render, then find section
            setTimeout(function() {
              var sectionRetries = 0;

              function tryFindSection() {
                if (gen !== scrapeGeneration) { done(null); return; }
                sectionRetries++;
                if (sectionRetries > 10) {
                  dbg("flow", "GAVE UP finding section: " + sectionName);
                  failedSections.push(sectionName);
                  nextSection();
                  return;
                }
                h.eval(scriptFindSection(sectionName));
              }

              setHandler(function(msg) {
                if (msg.type === "section-found") {
                  if (showProgress) { state.status = "scraping-playlists"; render(); }
                  // Wait for section page to render, then scrape playlists
                  setTimeout(function() {
                    scrapePlaylistsForSection(sectionName);
                  }, 4000);
                }
                if (msg.type === "section-not-found") {
                  setTimeout(tryFindSection, 2000);
                }
                if (msg.type === "playlists" && Array.isArray(msg.data)) {
                  var sectionPlaylists = msg.data;
                  for (var pi = 0; pi < sectionPlaylists.length; pi++) {
                    var pl = sectionPlaylists[pi];
                    if (!seenIds[pl.id]) {
                      seenIds[pl.id] = true;
                      pl.section = sectionName;
                      allPlaylists.push(pl);
                    }
                  }
                  dbg("flow", "section '" + sectionName + "' yielded " + sectionPlaylists.length + " playlists (" + allPlaylists.length + " total unique)");
                  nextSection();
                }
              });

              tryFindSection();
            }, sectionIdx > 1 ? 3000 : 0);
          }

          function scrapePlaylistsForSection(sectionName) {
            var plRetries = 0;

            function tryScrapePlaylists() {
              if (gen !== scrapeGeneration) { done(null); return; }
              plRetries++;
              if (plRetries > 10) {
                dbg("flow", "GAVE UP scraping playlists for section: " + sectionName);
                failedSections.push(sectionName);
                nextSection();
                return;
              }
              h.eval(SCRIPT_SCRAPE_PLAYLISTS);
            }

            // The playlists message is already handled in setHandler above
            tryScrapePlaylists();
          }

          nextSection();
        }

        // Phase 3: Scrape tracks for all collected playlists
        function scrapeAllTracks() {
          var trackIdx = 0;

          if (showProgress) {
            state.status = "scraping-tracks";
            state.scrapeProgress = { current: 0, total: allPlaylists.length, name: "" };
            render();
          }

          function scrapeNext() {
            if (gen !== scrapeGeneration) { done(null); return; }
            if (trackIdx >= allPlaylists.length) {
              // All done
              var result = { playlists: allPlaylists, tracks: allTracks };
              if (failedSections.length > 0) {
                result.failedSections = failedSections;
              }
              done(result);
              return;
            }
            var pl = allPlaylists[trackIdx];
            trackIdx++;
            if (showProgress) {
              state.scrapeProgress = { current: trackIdx, total: allPlaylists.length, name: pl.name };
              render();
            }

            h.eval(scriptNavigatePlaylist(pl.id));

            var trackTimeout = null;
            setHandler(function(msg) {
              if (msg.type === "tracks" && msg.data && msg.data.playlistId === pl.id) {
                if (trackTimeout) { clearTimeout(trackTimeout); trackTimeout = null; }
                allTracks[pl.id] = msg.data.tracks || [];
                setTimeout(scrapeNext, 1000);
              }
            });

            setTimeout(function() {
              if (gen !== scrapeGeneration) return;
              h.eval(scriptScrollThenScrape(pl.id, gen));
              trackTimeout = setTimeout(function() {
                allTracks[pl.id] = allTracks[pl.id] || [];
                scrapeNext();
              }, 45000);
            }, 4000);
          }

          scrapeNext();
        }

      }).catch(fail);
    });
  }

  // ---- Change detection ----

  function processRefreshResults(newPlaylists, newTracks) {
    var hasChanges = false;
    state.updatedPlaylistIds = {};

    // Snapshot current tracks as previous before overwriting
    var prevSnapshot = {};
    var keys = Object.keys(state.playlistTracks);
    for (var k = 0; k < keys.length; k++) {
      prevSnapshot[keys[k]] = state.playlistTracks[keys[k]];
    }
    state.previousTracks = prevSnapshot;

    for (var i = 0; i < newPlaylists.length; i++) {
      var pl = newPlaylists[i];
      var oldTracks = prevSnapshot[pl.id];
      var fresh = newTracks[pl.id] || [];

      if (tracksChanged(oldTracks, fresh)) {
        hasChanges = true;
        state.updatedPlaylistIds[pl.id] = true;
      }
    }

    state.playlists = newPlaylists;
    state.playlistTracks = newTracks;
    saveState();
    return { hasChanges: hasChanges };
  }

  // ---- Refresh ----

  function silentRefresh() {
    if (state.refreshing) return;
    state.refreshing = true;

    performScrape(false).then(function(result) {
      state.refreshing = false;
      if (!result) {
        recordCheckResult(0, 1);
        api.ui.setBadge("spotify", { type: "dot", variant: "error" });
        return;
      }
      var outcome = processRefreshResults(result.playlists, result.tracks);
      var errCount = result.failedSections ? result.failedSections.length : 0;
      recordCheckResult(result.playlists.length, errCount);
      cacheAllImages();
      if (outcome.hasChanges) {
        api.ui.setBadge("spotify", { type: "dot", variant: "accent" });
      }
      if (errCount > 0) {
        dbg("flow", "Silent refresh: could not find sections: " + result.failedSections.join(", "));
      }
      api.scheduler.complete("auto-refresh").catch(console.error);
      state.status = "done";
      render();
    }).catch(function(err) {
      state.refreshing = false;
      recordCheckResult(0, 1);
      console.error("Silent refresh failed:", err);
      api.ui.setBadge("spotify", { type: "dot", variant: "error" });
    });
  }

  // ---- Actions ----

  api.ui.onAction("open-spotify", function() {
    state.playlists = [];
    state.playlistTracks = {};
    state.status = "waiting-login";
    state.errorMessage = "";
    state.refreshSummary = "";
    state.updatedPlaylistIds = {};
    dbg("flow", "starting initial scrape via performScrape");
    render();

    performScrape(true, false).then(function(result) {
      if (!result) {
        state.status = "error";
        state.errorMessage = "Not logged in to Spotify. Click 'Open Spotify' to try again.";
        render();
        return;
      }
      state.playlists = result.playlists;
      state.playlistTracks = result.tracks;
      state.status = "done";
      var errCount = result.failedSections ? result.failedSections.length : 0;
      recordCheckResult(result.playlists.length, errCount);
      if (errCount > 0) {
        state.refreshSummary = "Could not find: " + result.failedSections.join(", ");
      }
      if (state.sections.length > 0) {
        state.activeTab = "section:" + state.sections[0];
      }
      saveState();
      cacheAllImages();
      render();
    }).catch(function(err) {
      state.status = "error";
      state.errorMessage = "Scrape failed: " + (err.message || err);
      recordCheckResult(0, 1);
      render();
    });
  });

  api.ui.onAction("cancel", function() {
    scrapeGeneration++;
    if (activeScrapeHandle) {
      activeScrapeHandle.close().catch(console.error);
      activeScrapeHandle = null;
    }
    state.status = "idle";
    state.refreshing = false;
    render();
  });

  api.ui.onAction("open-browser", function() {
    api.network.openBrowseWindow("https://open.spotify.com", {
      title: "Spotify",
      width: 1200,
      height: 800,
      visible: true,
    }).catch(console.error);
  });

  api.ui.onAction("refresh-section", function(data) {
    if (!data || !data.section) return;
    if (state.refreshing) return;
    var sectionName = data.section;
    state.refreshing = true;
    state.refreshSummary = "";
    state.status = "waiting-login";
    render();

    performScrape(true, state.showBrowserOnRefresh, [sectionName]).then(function(result) {
      state.refreshing = false;
      if (!result) {
        state.status = "error";
        state.errorMessage = "Not logged in to Spotify.";
        render();
        return;
      }
      // Merge: remove old playlists from this section, add new ones
      var kept = [];
      for (var i = 0; i < state.playlists.length; i++) {
        if ((state.playlists[i].section || "Playlists") !== sectionName) {
          kept.push(state.playlists[i]);
        }
      }
      for (var j = 0; j < result.playlists.length; j++) {
        kept.push(result.playlists[j]);
      }
      // Merge tracks
      var newTracks = {};
      var oldKeys = Object.keys(state.playlistTracks);
      for (var k = 0; k < oldKeys.length; k++) {
        newTracks[oldKeys[k]] = state.playlistTracks[oldKeys[k]];
      }
      var resKeys = Object.keys(result.tracks);
      for (var m = 0; m < resKeys.length; m++) {
        newTracks[resKeys[m]] = result.tracks[resKeys[m]];
      }
      state.playlists = kept;
      state.playlistTracks = newTracks;
      var errCount = result.failedSections ? result.failedSections.length : 0;
      recordCheckResult(result.playlists.length, errCount);
      saveState();
      cacheAllImages();
      state.status = "done";
      state.refreshSummary = "Refreshed " + sectionName + ": " + result.playlists.length + " playlists";
      if (errCount > 0) state.refreshSummary += " (" + errCount + " error" + (errCount > 1 ? "s" : "") + ")";
      render();
    }).catch(function(err) {
      state.refreshing = false;
      state.status = "error";
      state.errorMessage = "Refresh failed: " + (err.message || err);
      recordCheckResult(0, 1);
      render();
    });
  });

  api.ui.onAction("remove-section-tab", function(data) {
    if (!data || !data.section) return;
    var name = data.section;
    var idx = -1;
    for (var i = 0; i < state.sections.length; i++) {
      if (state.sections[i] === name) { idx = i; break; }
    }
    if (idx === -1) return;
    state.sections.splice(idx, 1);
    api.storage.set("spotify_browse_sections", state.sections).catch(console.error);
    state.activeTab = "saved";
    renderSettings();
    render();
  });

  api.ui.onAction("switch-tab", function(data) {
    if (!data || !data.tabId) return;
    if (data.tabId === "__add__") {
      state.addingSectionViaTab = true;
      render();
      return;
    }
    state.addingSectionViaTab = false;
    state.activeTab = data.tabId;
    if (data.tabId === "saved") loadArchives();
    render();
  });

  api.ui.onAction("section-tab-input", function(data) {
    if (data && data.value !== undefined) {
      pendingSectionInput = data.value;
    }
  });

  api.ui.onAction("section-tab-input:submit", function(data) {
    if (data && data.value) pendingSectionInput = data.value;
    addSectionFromTab();
  });

  api.ui.onAction("add-section-tab", function() {
    addSectionFromTab();
  });

  function addSectionFromTab() {
    var name = pendingSectionInput.trim();
    if (!name) return;
    for (var i = 0; i < state.sections.length; i++) {
      if (state.sections[i].toLowerCase() === name.toLowerCase()) return;
    }
    state.sections.push(name);
    pendingSectionInput = "";
    state.addingSectionViaTab = false;
    state.activeTab = "section:" + name;
    api.storage.set("spotify_browse_sections", state.sections).catch(console.error);
    renderSettings();
    render();
  }

  api.ui.onAction("cancel-add-section", function() {
    state.addingSectionViaTab = false;
    pendingSectionInput = "";
    render();
  });

  api.ui.onAction("go-home", function() {
    if (state.viewingArchived) {
      state.activeTab = "saved";
      state.viewingArchived = false;
    }
    state.currentPlaylist = null;
    state.currentView = "home";
    render();
  });

  api.ui.onAction("view-playlist", function(data) {
    if (!data || !data.itemId) return;
    var parts = data.itemId.split(":");
    if (parts[0] !== "playlist") return;
    var pid = parts.slice(1).join(":");
    for (var i = 0; i < state.playlists.length; i++) {
      if (state.playlists[i].id === pid) {
        state.currentPlaylist = state.playlists[i];
        state.viewingArchived = false;
        delete state.updatedPlaylistIds[pid];
        state.currentView = "playlist";
        renderPlaylist();
        return;
      }
    }
  });

  api.ui.onAction("archive-current", function() {
    var pl = state.currentPlaylist;
    if (!pl) return;
    archivePlaylist(pl);
  });

  // ---- Context menu actions for playlist cards ----

  function findPlaylistFromData(data) {
    if (!data || !data.itemId) return null;
    var parts = data.itemId.split(":");
    if (parts[0] !== "playlist") return null;
    var pid = parts.slice(1).join(":");
    for (var i = 0; i < state.playlists.length; i++) {
      if (state.playlists[i].id === pid) return state.playlists[i];
    }
    return null;
  }

  function playlistTracksToPayload(tracks) {
    var out = [];
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      var durationSecs = null;
      if (t.duration) {
        var parts = t.duration.split(":");
        if (parts.length === 2) {
          durationSecs = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
        }
      }
      out.push({
        title: t.name || "Unknown",
        artist_name: t.artist || null,
        album_title: t.album || null,
        duration_secs: durationSecs,
        image_url: t.imageUrl || undefined,
      });
    }
    return out;
  }

  api.ui.onAction("play-playlist", function(data) {
    var pl = findPlaylistFromData(data);
    if (!pl) return;
    var tracks = state.playlistTracks[pl.id] || [];
    if (tracks.length === 0) return;
    api.ui.requestAction("play-tracks", {
      tracks: playlistTracksToPayload(tracks),
      startIndex: 0,
      playlistName: pl.name,
      coverUrl: pl.imageUrl || undefined,
    });
  });

  api.ui.onAction("enqueue-playlist", function(data) {
    var pl = findPlaylistFromData(data);
    if (!pl) return;
    var tracks = state.playlistTracks[pl.id] || [];
    if (tracks.length === 0) return;
    api.ui.requestAction("enqueue-tracks", { tracks: playlistTracksToPayload(tracks) });
  });

  api.ui.onAction("archive-playlist", function(data) {
    var pl = findPlaylistFromData(data);
    if (!pl) return;
    archivePlaylist(pl);
  });

  function savePlaylistToApp(pl) {
    var tracks = state.playlistTracks[pl.id] || [];
    var now = new Date();
    var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    var dateStr = now.getDate() + " " + months[now.getMonth()] + " " + now.getFullYear();
    var name = pl.name + " " + dateStr;

    var trackPayloads = [];
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      var durationSecs = null;
      if (t.duration) {
        var parts = t.duration.split(":");
        if (parts.length === 2) {
          durationSecs = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
        }
      }
      trackPayloads.push({
        title: t.name || "Unknown",
        artistName: t.artist || null,
        albumName: t.album || null,
        durationSecs: durationSecs,
        source: null,
        imageUrl: t.imageUrl || null,
      });
    }

    api.playlists.save({
      name: name,
      source: "spotify-playlist://" + pl.id,
      imageUrl: pl.imageUrl || null,
      tracks: trackPayloads,
    }).then(function() {
      api.ui.showNotification("Saved to Playlists: " + name);
    }).catch(function(err) {
      console.error("Failed to save playlist:", err);
      api.ui.showNotification("Failed to save playlist");
    });
  }

  api.ui.onAction("save-playlist", function() {
    var pl = state.currentPlaylist;
    if (!pl) return;
    savePlaylistToApp(pl);
  });

  api.ui.onAction("save-playlist-ctx", function(data) {
    var pl = findPlaylistFromData(data);
    if (!pl) return;
    savePlaylistToApp(pl);
  });

  function getArchivedByIndex(data) {
    if (!data || !data.itemId) return null;
    var parts = data.itemId.split(":");
    if (parts[0] !== "archived") return null;
    var idx = parseInt(parts[1], 10);
    return (idx >= 0 && idx < state.archivedPlaylists.length) ? { index: idx, entry: state.archivedPlaylists[idx] } : null;
  }

  function archivedTracksToPayload(tracks) {
    var out = [];
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      var durationSecs = null;
      if (t.duration) {
        var parts = t.duration.split(":");
        if (parts.length === 2) {
          durationSecs = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
        }
      }
      out.push({
        title: t.name || "Unknown",
        artist_name: t.artist || null,
        album_title: t.album || null,
        duration_secs: durationSecs,
        image_url: t.imageUrl || undefined,
      });
    }
    return out;
  }

  api.ui.onAction("view-archived", function(data) {
    var found = getArchivedByIndex(data);
    if (!found) return;
    var entry = found.entry;
    state.viewingArchived = true;
    var viewId = "archived:" + found.index;
    state.currentPlaylist = { id: viewId, name: entry.name, imageUrl: entry.imageUrl };
    state.playlistTracks[viewId] = entry.tracks || [];
    state.currentView = "playlist";
    renderPlaylist();
  });

  api.ui.onAction("play-archived", function(data) {
    var found = getArchivedByIndex(data);
    if (!found || !found.entry.tracks || found.entry.tracks.length === 0) return;
    api.ui.requestAction("play-tracks", {
      tracks: archivedTracksToPayload(found.entry.tracks),
      startIndex: 0,
      playlistName: found.entry.name,
      coverUrl: found.entry.imageUrl || undefined,
    });
  });

  api.ui.onAction("enqueue-archived", function(data) {
    var found = getArchivedByIndex(data);
    if (!found || !found.entry.tracks || found.entry.tracks.length === 0) return;
    api.ui.requestAction("enqueue-tracks", { tracks: archivedTracksToPayload(found.entry.tracks) });
  });

  api.ui.onAction("delete-archived", function(data) {
    var found = getArchivedByIndex(data);
    if (!found) return;
    state.archivedPlaylists.splice(found.index, 1);
    saveArchives();
    api.ui.showNotification("Archive deleted");
    render();
  });

  api.ui.onAction("manual-refresh", function() {
    if (state.refreshing) return;
    state.refreshing = true;
    state.refreshSummary = "";
    state.status = "waiting-login";
    render();

    performScrape(true, state.showBrowserOnRefresh).then(function(result) {
      state.refreshing = false;
      if (!result) {
        state.status = "error";
        state.errorMessage = "Not logged in to Spotify. Click 'Open Spotify' to log in.";
        render();
        return;
      }
      var outcome = processRefreshResults(result.playlists, result.tracks);
      var errCount = result.failedSections ? result.failedSections.length : 0;
      recordCheckResult(result.playlists.length, errCount);
      cacheAllImages();
      state.status = "done";
      var updatedCount = Object.keys(state.updatedPlaylistIds).length;
      var summaryParts = [];
      if (updatedCount > 0) {
        summaryParts.push("Updated " + updatedCount + " playlist" + (updatedCount > 1 ? "s" : ""));
      } else {
        summaryParts.push("No changes detected");
      }
      if (errCount > 0) {
        summaryParts.push("Could not find: " + result.failedSections.join(", "));
      }
      state.refreshSummary = summaryParts.join(". ");
      render();
    }).catch(function(err) {
      state.refreshing = false;
      state.status = "error";
      state.errorMessage = "Refresh failed: " + (err.message || err);
      recordCheckResult(0, 1);
      render();
    });
  });

  // ---- Settings actions ----

  api.ui.onAction("section-input", function(data) {
    if (data && data.value !== undefined) {
      pendingSectionInput = data.value;
    }
  });

  api.ui.onAction("section-input:submit", function(data) {
    if (data && data.value) pendingSectionInput = data.value;
    var name = pendingSectionInput.trim();
    if (!name) return;
    for (var i = 0; i < state.sections.length; i++) {
      if (state.sections[i].toLowerCase() === name.toLowerCase()) return;
    }
    state.sections.push(name);
    pendingSectionInput = "";
    api.storage.set("spotify_browse_sections", state.sections).catch(console.error);
    renderSettings();
    render();
  });

  api.ui.onAction("add-section", function() {
    var name = pendingSectionInput.trim();
    if (!name) return;
    for (var i = 0; i < state.sections.length; i++) {
      if (state.sections[i].toLowerCase() === name.toLowerCase()) return;
    }
    state.sections.push(name);
    pendingSectionInput = "";
    api.storage.set("spotify_browse_sections", state.sections).catch(console.error);
    renderSettings();
    render();
  });

  api.ui.onAction("remove-section", function(data) {
    if (!data || data.index === undefined) return;
    var idx = data.index;
    if (idx >= 0 && idx < state.sections.length) {
      var removed = state.sections[idx];
      state.sections.splice(idx, 1);
      api.storage.set("spotify_browse_sections", state.sections).catch(console.error);
      if (state.activeTab === "section:" + removed) {
        state.activeTab = "saved";
      }
      renderSettings();
      render();
    }
  });

  api.ui.onAction("toggle-show-browser-pref", function() {
    state.showBrowserOnRefresh = !state.showBrowserOnRefresh;
    savePreferences();
    renderSettings();
  });

  api.ui.onAction("set-auto-refresh", function(data) {
    if (!data || data.value === undefined) return;
    var hrs = parseInt(data.value, 10);
    state.autoRefreshHours = hrs;
    savePreferences();
    registerAutoRefresh();
    renderSettings();
  });

  // ---- Init: restore previous data ----

  // Restore state (with legacy migration)
  api.storage.get("spotify_browse_state").then(function(saved) {
    if (saved && saved.playlists && saved.playlists.length > 0) {
      state.playlists = saved.playlists;
      state.playlistTracks = saved.playlistTracks || {};
      state.previousTracks = saved.previousTracks || {};
      state.savedAt = saved.savedAt || null;
      state.status = "done";
      render();
    } else {
      api.storage.get("spotify_browse_playlists").then(function(legacy) {
        if (legacy && legacy.playlists && legacy.playlists.length > 0) {
          state.playlists = legacy.playlists;
          state.playlistTracks = legacy.tracks || {};
          state.status = "done";
          saveState();
          api.storage.delete("spotify_browse_playlists").catch(console.error);
        }
        render();
      }).catch(function(err) { console.error("Failed to load legacy state:", err); render(); });
    }
  }).catch(function(err) { console.error("Failed to load state:", err); render(); });

  // Load sections
  api.storage.get("spotify_browse_sections").then(function(sections) {
    if (sections && Array.isArray(sections)) {
      state.sections = sections;
    }
  }).catch(console.error);

  // Load preferences
  api.storage.get("spotify_browse_preferences").then(function(prefs) {
    if (prefs) {
      state.showBrowserOnRefresh = !!prefs.showBrowserOnRefresh;
      if (prefs.autoRefreshHours !== undefined) state.autoRefreshHours = prefs.autoRefreshHours;
      if (prefs.lastCheckAt) state.lastCheckAt = prefs.lastCheckAt;
      if (prefs.lastCheckResult) state.lastCheckResult = prefs.lastCheckResult;
      registerAutoRefresh();
      renderSettings();
      render();
    }
  }).catch(console.error);

  // One-time archive cleanup migration
  api.storage.get("spotify_browse_archive_index").then(function(index) {
    if (!index || !index.length) return;
    var promises = [];
    for (var i = 0; i < index.length; i++) {
      promises.push(api.storage.delete("spotify_browse_archive:" + index[i].storageKey));
    }
    promises.push(api.storage.delete("spotify_browse_archive_index"));
    Promise.all(promises).catch(console.error);
  }).catch(console.error);

  // Clean up orphaned cache directories
  api.informationTypes.invoke("plugin_cache_list_dirs", {
    pluginId: "spotify-browse",
  }).then(function(dirs) {
    if (!dirs || !dirs.length) return;
    var knownIds = {};
    for (var i = 0; i < state.playlists.length; i++) {
      knownIds[state.playlists[i].id] = true;
    }
    for (var d = 0; d < dirs.length; d++) {
      if (!knownIds[dirs[d]]) {
        api.informationTypes.invoke("plugin_cache_delete_dir", {
          pluginId: "spotify-browse",
          subdir: dirs[d],
        }).catch(console.error);
      }
    }
  }).catch(console.error);

  function registerAutoRefresh() {
    if (state.autoRefreshHours > 0) {
      api.scheduler.register("auto-refresh", state.autoRefreshHours * 60 * 60 * 1000).catch(console.error);
    } else {
      api.scheduler.unregister("auto-refresh").catch(console.error);
    }
  }

  api.scheduler.onDue("auto-refresh", function() {
    silentRefresh();
  });
  registerAutoRefresh();

  // Load archived playlists
  loadArchives();

  // Render settings panel
  renderSettings();
}

function deactivate() {}

return { activate: activate, deactivate: deactivate };
