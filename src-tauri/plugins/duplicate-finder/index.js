// Duplicate Finder — surfaces library tracks that are the same song held more
// than once (re-downloaded, or sitting in two scanned folders) so the user can
// reclaim space. All the grouping work happens in Rust
// (`api.library.findDuplicates` → `find_duplicate_tracks`), which buckets by a
// diacritic-normalized title+artist and can also require duration / file-size
// agreement. Deletes are handed straight to the host's canonical
// delete-with-confirmation flow via `api.ui.requestAction("delete-tracks")`, so
// this plugin never re-implements trashing, queue cleanup, or "stop the playing
// track" logic.
function activate(api) {
  var VIEW = "duplicate-finder";

  // How many duplicate groups to render at once. A pathological library could
  // return hundreds; each group is its own selectable list, so cap the DOM and
  // tell the user the rest will appear after they thin the shown ones out.
  var MAX_GROUPS = 150;

  var state = {
    loading: false,    // a scan is in flight
    scanned: false,    // a scan has completed at least once this session
    error: "",         // last scan error (shown in the toolbar status)
    groups: [],        // Track[][], each keeper-first (group[0] = best copy)
    byId: {},          // track id -> Track, for play-by-row
    matchDuration: false,
    matchSize: false,
  };

  // ---- formatting -------------------------------------------------------

  function fmtBytes(n) {
    if (!n || n <= 0) return "—";
    if (n < 1024) return n + " B";
    var kb = n / 1024;
    if (kb < 1024) return kb.toFixed(0) + " KB";
    var mb = kb / 1024;
    if (mb < 1024) return mb.toFixed(mb < 10 ? 1 : 0) + " MB";
    return (mb / 1024).toFixed(2) + " GB";
  }

  function fmtDuration(secs) {
    if (secs == null || isNaN(secs)) return "";
    var s = Math.round(secs);
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ":" + (r < 10 ? "0" + r : r);
  }

  function fmtBitrate(t) {
    if (!t.file_size || !t.duration_secs || t.duration_secs <= 0) return "";
    var kbps = (t.file_size * 8) / t.duration_secs / 1000;
    if (kbps >= 1000) return (kbps / 1000).toFixed(1) + " Mbps";
    return Math.round(kbps) + " kbps";
  }

  // Quality summary — the line that actually differs between copies of one song.
  function qualityLabel(t) {
    var parts = [];
    if (t.format) parts.push(String(t.format).toUpperCase());
    var br = fmtBitrate(t);
    if (br) parts.push(br);
    parts.push(fmtBytes(t.file_size));
    return parts.join(" · ");
  }

  function cleanPath(p) {
    if (!p) return "";
    var s = String(p);
    var idx = s.indexOf("://");
    if (idx !== -1) s = s.slice(idx + 3);
    try { s = decodeURIComponent(s); } catch (e) { /* leave raw if not valid %-encoding */ }
    return s;
  }

  function dirOf(p) {
    var s = cleanPath(p);
    var slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return slash > 0 ? s.slice(0, slash) : s;
  }

  // Where this copy lives — what lets the user tell two copies apart at a glance.
  function locationLabel(t) {
    var dir = dirOf(t.path);
    return t.collection_name ? (t.collection_name + " · " + dir) : dir;
  }

  function summary() {
    var extras = 0;
    var reclaimable = 0;
    for (var i = 0; i < state.groups.length; i++) {
      var g = state.groups[i];
      for (var j = 1; j < g.length; j++) { // copies beyond the keeper
        extras++;
        reclaimable += g[j].file_size || 0;
      }
    }
    return { groups: state.groups.length, extras: extras, reclaimable: reclaimable };
  }

  // ---- render -----------------------------------------------------------

  function statusLine() {
    if (state.loading) return "Scanning…";
    if (state.error) return state.error;
    if (!state.scanned) return "Not scanned yet";
    var s = summary();
    if (s.groups === 0) return "No duplicates found";
    return s.groups + " group" + (s.groups === 1 ? "" : "s") +
      " · " + s.extras + " extra cop" + (s.extras === 1 ? "y" : "ies") +
      " · " + fmtBytes(s.reclaimable) + " reclaimable";
  }

  function statusVariant() {
    if (state.error) return "error";
    if (state.scanned && !state.loading && state.groups.length === 0) return "success";
    return "default";
  }

  function groupSection(group, index) {
    var keeper = group[0];
    var extras = group.slice(1);
    var reclaim = 0;
    for (var i = 0; i < extras.length; i++) reclaim += extras[i].file_size || 0;

    var items = group.map(function (t, idx) {
      var isKeeper = idx === 0;
      var loc = locationLabel(t);
      return {
        id: String(t.id),
        title: (isKeeper ? "★ " : "") + qualityLabel(t),
        subtitle: isKeeper ? ("Recommended to keep · " + loc) : loc,
        duration: fmtDuration(t.duration_secs),
        action: "play-copy", // double-click / Enter plays just this copy
      };
    });

    var titleArtist = (keeper.artist_name ? keeper.artist_name + " — " : "") + keeper.title;

    var children = [
      {
        type: "track-row-list",
        items: items,
        selectable: true,
        // Hover a row → delete just it; select several → the toolbar "Delete"
        // applies to the whole selection. Both fire "delete-selected".
        actions: [{ id: "delete-selected", label: "Delete", icon: "🗑" }],
      },
      {
        type: "button",
        label: "Delete " + extras.length + " extra" + (extras.length === 1 ? "" : "s") +
          " (keep best) · frees " + fmtBytes(reclaim),
        action: "delete-extras",
        variant: "secondary",
        data: { trackIds: extras.map(function (e) { return e.id; }) },
      },
    ];

    return {
      type: "section",
      title: titleArtist + "  ·  " + group.length + " copies",
      children: children,
    };
  }

  function render() {
    var children = [];

    children.push({
      type: "toolbar",
      title: "Duplicate Finder",
      buttons: [{
        label: state.loading ? "Scanning…" : (state.scanned ? "Rescan" : "Scan library"),
        action: "rescan",
        variant: "accent",
        disabled: state.loading,
      }],
      status: statusLine(),
      statusVariant: statusVariant(),
    });

    // The toolbar is pinned (hoisted out of the scroll area), so the first
    // content node sits flush against its border — add a little breathing room.
    children.push({ type: "spacer" });

    children.push({
      type: "section",
      title: "Matching",
      children: [
        {
          type: "toggle",
          label: "Also require matching duration",
          description: "Only group copies whose length is within ~2 seconds.",
          action: "toggle-duration",
          checked: state.matchDuration,
          disabled: state.loading,
        },
        {
          type: "toggle",
          label: "Also require matching file size",
          description: "Only group copies whose size is within ~5%.",
          action: "toggle-size",
          checked: state.matchSize,
          disabled: state.loading,
        },
      ],
    });

    if (state.loading) {
      children.push({ type: "loading", message: "Scanning your library for duplicate songs…" });
    } else if (state.error) {
      children.push({ type: "text", content: state.error, className: "plugin-error" });
    } else if (!state.scanned) {
      children.push({
        type: "text",
        content:
          "Scan your local library for the same song held more than once — re-downloaded copies, " +
          "or a track that lives in two scanned folders. Matching ignores accents and case " +
          "(Björk = Bjork). Press Scan library to begin.",
        className: "plugin-hint",
      });
    } else if (state.groups.length === 0) {
      children.push({ type: "text", content: "No duplicates found — your library is clean. 🎉" });
    } else {
      var s = summary();
      children.push({
        type: "stats-grid",
        items: [
          { label: "Duplicate groups", value: s.groups },
          { label: "Extra copies", value: s.extras },
          { label: "Reclaimable", value: fmtBytes(s.reclaimable) },
        ],
      });

      var shown = state.groups.slice(0, MAX_GROUPS);
      for (var i = 0; i < shown.length; i++) {
        children.push(groupSection(shown[i], i));
      }
      if (state.groups.length > MAX_GROUPS) {
        children.push({
          type: "text",
          content: "Showing the first " + MAX_GROUPS + " of " + state.groups.length +
            " groups. Clear some, then rescan to see the rest.",
          className: "plugin-hint",
        });
      }
    }

    api.ui.setViewData(VIEW, { type: "layout", direction: "vertical", children: children }, { scrollKey: "main" });
  }

  // ---- scan -------------------------------------------------------------

  function scan() {
    state.loading = true;
    state.error = "";
    render();
    api.library.findDuplicates({
      matchDuration: state.matchDuration,
      matchSize: state.matchSize,
    }).then(function (groups) {
      state.groups = Array.isArray(groups) ? groups : [];
      state.byId = {};
      for (var i = 0; i < state.groups.length; i++) {
        var g = state.groups[i];
        for (var j = 0; j < g.length; j++) state.byId[String(g[j].id)] = g[j];
      }
      state.loading = false;
      state.scanned = true;
      render();
    }, function (e) {
      console.error("duplicate-finder: scan failed:", e);
      state.loading = false;
      state.scanned = true;
      state.groups = [];
      state.error = "Scan failed: " + (e && e.message ? e.message : String(e));
      render();
    });
  }

  // ---- deletes (routed through the host's canonical flow) ---------------

  function requestDelete(ids) {
    var nums = [];
    for (var i = 0; i < (ids || []).length; i++) {
      var n = typeof ids[i] === "number" ? ids[i] : parseInt(ids[i], 10);
      if (!isNaN(n)) nums.push(n);
    }
    if (!nums.length) return;
    // The host shows its standard confirm modal, trashes the files, cleans the
    // queue, and emits track:removed — which triggers our rescan below.
    api.ui.requestAction("delete-tracks", { trackIds: nums });
  }

  // ---- actions ----------------------------------------------------------

  api.ui.onAction("rescan", function () { scan(); });

  api.ui.onAction("toggle-duration", function (d) {
    state.matchDuration = !!(d && d.value);
    persistPrefs();
    if (state.scanned) scan(); else render();
  });

  api.ui.onAction("toggle-size", function (d) {
    state.matchSize = !!(d && d.value);
    persistPrefs();
    if (state.scanned) scan(); else render();
  });

  api.ui.onAction("play-copy", function (d) {
    var t = d && d.itemId != null ? state.byId[String(d.itemId)] : null;
    if (!t) return;
    api.playback.playTracks([{
      path: t.path,
      title: t.title,
      artist_name: t.artist_name,
      album_title: t.album_title,
      duration_secs: t.duration_secs,
      track_number: t.track_number,
    }], 0);
  });

  // Fired by both the per-row trash button ({ itemId, selectedIds:[id] }) and
  // the list's "Delete" toolbar button ({ selectedIds:[...] }).
  api.ui.onAction("delete-selected", function (d) {
    requestDelete((d && d.selectedIds) || []);
  });

  // The per-group "Delete N extras (keep best)" button carries numeric ids.
  api.ui.onAction("delete-extras", function (d) {
    requestDelete((d && d.trackIds) || []);
  });

  // ---- refresh after deletes -------------------------------------------
  // delete_tracks emits one track-removed per file; debounce so a multi-track
  // delete triggers a single rescan. Only rescan once the user has actually
  // used the tool this session (so deletes made elsewhere don't spin up a scan
  // in the background).
  var rescanTimer = null;
  function scheduleRescan() {
    if (!state.scanned || state.loading) return;
    if (rescanTimer) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(function () { rescanTimer = null; scan(); }, 400);
  }
  api.library.onTrackRemoved(scheduleRescan);
  api.library.onTrackAdded(scheduleRescan);
  api.library.onScanComplete(scheduleRescan);

  // ---- prefs + boot -----------------------------------------------------

  function persistPrefs() {
    api.storage.set("prefs", { matchDuration: state.matchDuration, matchSize: state.matchSize })
      .then(null, function (e) { console.error("duplicate-finder: persist prefs failed:", e); });
  }

  api.storage.get("prefs").then(function (p) {
    if (p) {
      state.matchDuration = !!p.matchDuration;
      state.matchSize = !!p.matchSize;
    }
    render(); // no auto-scan: this is an on-demand maintenance tool
  }, function (e) {
    console.error("duplicate-finder: load prefs failed:", e);
    render();
  });
}

function deactivate() {}

return { activate: activate, deactivate: deactivate };
