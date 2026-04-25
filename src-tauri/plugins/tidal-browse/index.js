// TIDAL Browse Plugin for Viboplr
// Provides TIDAL search, streaming, and download via plugin system

var __healthCheckInterval = null;

function activate(api) {
  var state = {
    currentView: "search",
    searchResults: null,
    activeTab: "tracks",
    viewStack: [],
    lastQuery: "",
    albumDetail: null,
    artistDetail: null,
    streamingQuality: "HIGH",
    apiDown: true,
    streamingDown: true,
    lastHealthCheck: null,
  };

  // -- TIDAL HTTP client --

  var UPTIME_URLS = [
    "https://tidal-uptime.jiffy-puffs-1j.workers.dev/",
    "https://tidal-uptime.props-76styles.workers.dev/",
  ];
  var CACHE_TTL_MS = 1800000; // 30 minutes

  var instanceCache = null; // { apiUrls: [], streamingUrls: [], fetchedAt: number }

  async function fetchInstances() {
    for (var i = 0; i < UPTIME_URLS.length; i++) {
      try {
        var resp = await api.network.fetch(UPTIME_URLS[i]);
        if (resp.status !== 200) continue;
        var json = await resp.json();
        var apiUrls = (json.api || []).map(function (item) {
          return item.url.replace(/\/+$/, "");
        });
        var streamingUrls = (json.streaming || []).map(function (item) {
          return item.url.replace(/\/+$/, "");
        });
        instanceCache = { apiUrls: apiUrls, streamingUrls: streamingUrls, fetchedAt: Date.now() };
        state.lastHealthCheck = Date.now();
        updateHealthState(apiUrls.length > 0, streamingUrls.length > 0);
        return;
      } catch (e) {
        // try next uptime URL
      }
    }
    // all uptime URLs failed — mark everything down
    state.lastHealthCheck = Date.now();
    updateHealthState(false, false);
  }

  function updateHealthState(apiUp, streamingUp) {
    var changed = (state.apiDown !== !apiUp) || (state.streamingDown !== !streamingUp);
    state.apiDown = !apiUp;
    state.streamingDown = !streamingUp;
    if (changed) {
      var parts = [];
      if (apiUp) parts.push("API: up"); else parts.push("API: down");
      if (streamingUp) parts.push("streaming: up"); else parts.push("streaming: down");
      rustLog(apiUp && streamingUp ? "info" : "warn", "TIDAL health check — " + parts.join(", "));
    }
    render();
  }

  async function getApiUrls() {
    if (instanceCache && (Date.now() - instanceCache.fetchedAt) < CACHE_TTL_MS) {
      return instanceCache.apiUrls;
    }
    await fetchInstances();
    return instanceCache ? instanceCache.apiUrls : [];
  }

  async function getStreamingUrls() {
    if (instanceCache && (Date.now() - instanceCache.fetchedAt) < CACHE_TTL_MS) {
      return instanceCache.streamingUrls.length > 0 ? instanceCache.streamingUrls : instanceCache.apiUrls;
    }
    await fetchInstances();
    if (!instanceCache) return [];
    return instanceCache.streamingUrls.length > 0 ? instanceCache.streamingUrls : instanceCache.apiUrls;
  }

  async function tidalFetch(path) {
    var isStreaming = path.indexOf("/track") === 0 || path.indexOf("/stream") === 0;
    if (isStreaming && state.streamingDown) {
      throw new Error("TIDAL streaming servers are currently unavailable");
    }
    if (!isStreaming && state.apiDown) {
      throw new Error("TIDAL API servers are currently unavailable");
    }
    var urls = isStreaming ? await getStreamingUrls() : await getApiUrls();
    if (urls.length === 0) {
      throw new Error("No TIDAL instances available");
    }
    for (var i = 0; i < urls.length; i++) {
      try {
        var resp = await api.network.fetch(urls[i] + path);
        if (resp.status >= 200 && resp.status < 300) {
          return resp.json();
        }
      } catch (e) {
        // try next instance
      }
    }
    instanceCache = null;
    throw new Error("All TIDAL instances failed");
  }

  async function tidalGetStreamUrl(trackId, quality) {
    var json = await tidalFetch("/track/?id=" + trackId + "&quality=" + (quality || "LOSSLESS"));
    var data = json.data || json;
    var manifest = data.manifest || "";
    if (!manifest) return null;
    var manifestType = data.manifestMimeType || "application/vnd.tidal.bts";
    if (manifestType !== "application/vnd.tidal.bts") return null;
    try {
      var decoded = atob(manifest);
      var parsed = JSON.parse(decoded);
      var urls = parsed.urls || [];
      return urls[0] || null;
    } catch (e) {
      return null;
    }
  }

  async function tidalGetTrackInfo(trackId) {
    var json = await tidalFetch("/info/?id=" + trackId);
    var data = json.data || json;
    return parseTrack(data);
  }

  function parseTrack(t) {
    var artist = (t.artist && t.artist.name) ? t.artist.name
      : (t.artists && t.artists[0] && t.artists[0].name) ? t.artists[0].name
      : null;
    var artistId = (t.artist && t.artist.id) ? String(t.artist.id)
      : (t.artists && t.artists[0] && t.artists[0].id) ? String(t.artists[0].id)
      : null;
    return {
      tidal_id: t.id ? String(t.id) : "",
      title: t.title || "Unknown",
      artist_name: artist,
      artist_id: artistId,
      album_title: t.album && t.album.title ? t.album.title : null,
      album_id: t.album && t.album.id ? String(t.album.id) : null,
      cover_id: t.album && t.album.cover ? t.album.cover : null,
      duration_secs: t.duration || null,
      track_number: t.trackNumber || null,
    };
  }

  function parseAlbum(a) {
    return {
      tidal_id: a.id ? String(a.id) : "",
      title: a.title || "Unknown",
      artist_name: (a.artists && a.artists[0] && a.artists[0].name) ? a.artists[0].name : null,
      cover_id: a.cover || null,
      year: a.releaseDate ? parseInt(a.releaseDate.split("-")[0], 10) || null : null,
    };
  }

  function parseArtist(a) {
    return {
      tidal_id: a.id ? String(a.id) : "",
      name: a.name || "Unknown",
      picture_id: a.picture || a.pictureId || null,
    };
  }

  async function tidalSearch(query, limit, offset) {
    var encoded = encodeURIComponent(query);
    var trackPath = "/search/?s=" + encoded + "&limit=" + limit + "&offset=" + (offset || 0);
    var artistPath = "/search/?a=" + encoded + "&limit=" + limit + "&offset=" + (offset || 0);
    var albumPath = "/search/?al=" + encoded + "&limit=" + limit + "&offset=" + (offset || 0);

    var results = await Promise.all([
      tidalFetch(trackPath).catch(function () { return null; }),
      tidalFetch(artistPath).catch(function () { return null; }),
      tidalFetch(albumPath).catch(function () { return null; }),
    ]);

    var tracks = [];
    var artists = [];
    var albums = [];

    if (results[0] && results[0].data && results[0].data.items) {
      tracks = results[0].data.items.map(parseTrack);
    }
    if (results[1] && results[1].data && results[1].data.artists && results[1].data.artists.items) {
      artists = results[1].data.artists.items.map(parseArtist);
    }
    if (results[2] && results[2].data && results[2].data.albums && results[2].data.albums.items) {
      albums = results[2].data.albums.items.map(parseAlbum);
    }

    return { tracks: tracks, albums: albums, artists: artists };
  }

  async function tidalGetAlbum(id) {
    var json = await tidalFetch("/album/?id=" + id);
    var data = json.data || json;
    var albumData = (data.album && typeof data.album === "object") ? data.album : data;
    var items = data.items || [];
    var tracks = items
      .filter(function (item) { return item.item && item.item !== null; })
      .map(function (item) { return parseTrack(item.item); });

    return {
      tidal_id: albumData.id ? String(albumData.id) : "",
      title: albumData.title || "Unknown",
      artist_name: (albumData.artists && albumData.artists[0] && albumData.artists[0].name) ? albumData.artists[0].name : null,
      cover_id: albumData.cover || null,
      year: albumData.releaseDate ? parseInt(albumData.releaseDate.split("-")[0], 10) || null : null,
      tracks: tracks,
    };
  }

  async function tidalGetArtistAlbums(id) {
    var json = await tidalFetch("/artist/?f=" + id + "&skip_tracks=true");
    var items = (json.albums && json.albums.items) || (json.data && json.data.albums) || [];
    if (!Array.isArray(items)) items = [];
    return items.map(parseAlbum);
  }

  async function tidalGetArtist(id) {
    var json = await tidalFetch("/artist/?id=" + id);
    var artistData = (json.artist && typeof json.artist === "object") ? json.artist : (json.data || {});
    var albums = [];
    try { albums = await tidalGetArtistAlbums(id); } catch (e) { /* ignore */ }

    return {
      tidal_id: artistData.id ? String(artistData.id) : "",
      name: artistData.name || "Unknown",
      picture_id: artistData.picture || artistData.pictureId || null,
      albums: albums,
    };
  }

  async function tidalCheckStatus() {
    try {
      var urls = await getApiUrls();
      return { available: urls.length > 0, instance_count: urls.length };
    } catch (e) {
      return { available: false, instance_count: 0 };
    }
  }

  function coverUrl(coverId, size) {
    if (!coverId) return undefined;
    var path = coverId.replace(/-/g, "/");
    return "https://resources.tidal.com/images/" + path + "/" + size + "x" + size + ".jpg";
  }

  function formatDuration(secs) {
    if (!secs) return "";
    var m = Math.floor(secs / 60);
    var s = Math.floor(secs % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function formatTime(timestamp) {
    if (!timestamp) return "";
    var d = new Date(timestamp);
    var h = d.getHours();
    var m = d.getMinutes();
    var ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return h + ":" + (m < 10 ? "0" : "") + m + " " + ampm;
  }

  // -- Image providers --

  api.imageProviders.onFetch("artist", async function (name) {
    if (state.apiDown) return { status: "not_found" };
    var results = await tidalSearch(name, 1);
    var artist = results && results.artists && results.artists[0];
    if (!artist || !artist.picture_id) return { status: "not_found" };
    var url = coverUrl(artist.picture_id, 750);
    return { status: "ok", url: url };
  });

  api.imageProviders.onFetch("album", async function (name, artistName) {
    if (state.apiDown) return { status: "not_found" };
    var query = artistName ? artistName + " " + name : name;
    var results = await tidalSearch(query, 1);
    var album = results && results.albums && results.albums[0];
    if (!album || !album.cover_id) return { status: "not_found" };
    var url = coverUrl(album.cover_id, 1280);
    return { status: "ok", url: url };
  });

  // -- View rendering --

  function renderSearchView() {
    var children = [];

    var checkedSuffix = state.lastHealthCheck ? " (last checked at " + formatTime(state.lastHealthCheck) + ")" : "";
    if (state.apiDown && state.streamingDown) {
      children.push({
        type: "layout",
        direction: "horizontal",
        className: "ds-banner ds-banner--error",
        children: [
          { type: "text", content: "TIDAL servers are currently unavailable" + checkedSuffix },
          { type: "button", label: "Check Now", action: "check-health", className: "ds-btn ds-btn--sm ds-btn--secondary" },
        ],
      });
    } else if (state.streamingDown) {
      children.push({
        type: "layout",
        direction: "horizontal",
        className: "ds-banner ds-banner--warning",
        children: [
          { type: "text", content: "TIDAL streaming is unavailable — search may still work" + checkedSuffix },
          { type: "button", label: "Check Now", action: "check-health", className: "ds-btn ds-btn--sm ds-btn--secondary" },
        ],
      });
    }

    children.push({
      type: "search-input",
      placeholder: "Search TIDAL...",
      action: "search",
      value: state.lastQuery,
    });

    var trackCount = state.searchResults ? (state.searchResults.tracks || []).length : 0;
    var albumCount = state.searchResults ? (state.searchResults.albums || []).length : 0;
    var artistCount = state.searchResults ? (state.searchResults.artists || []).length : 0;

    children.push({
      type: "tabs",
      tabs: [
        { id: "tracks", label: "Tracks", count: trackCount || undefined },
        { id: "albums", label: "Albums", count: albumCount || undefined },
        { id: "artists", label: "Artists", count: artistCount || undefined },
      ],
      activeTab: state.activeTab,
      action: "switch-tab",
    });

    if (!state.searchResults) {
      children.push({
        type: "text",
        content: "Search TIDAL for tracks, albums, and artists.",
        className: "ds-empty",
      });
    } else if (state.activeTab === "tracks") {
      var tracks = state.searchResults.tracks || [];
      if (tracks.length === 0) {
        children.push({ type: "text", content: "No tracks found.", className: "ds-empty" });
      } else {
        children.push({
          type: "track-row-list",
          selectable: true,
          actions: [
            { id: "play-selected", label: "Play", icon: "\u25B6" },
            { id: "queue-selected", label: "Queue", icon: "+" },
            { id: "download-selected", label: "Download", icon: "\u2B07" },
          ],
          items: tracks.map(function (t) {
            return {
              id: "track:" + t.tidal_id,
              title: t.title,
              subtitle: (t.artist_name || "Unknown") + " \u2014 " + (t.album_title || ""),
              imageUrl: coverUrl(t.cover_id, 160),
              duration: formatDuration(t.duration_secs),
              action: "play-track",
            };
          }),
        });
      }
    } else if (state.activeTab === "albums") {
      var albums = state.searchResults.albums || [];
      if (albums.length === 0) {
        children.push({ type: "text", content: "No albums found.", className: "ds-empty" });
      } else {
        children.push({
          type: "card-grid",
          items: albums.map(function (a) {
            return {
              id: "album:" + a.tidal_id,
              title: a.title,
              subtitle: (a.artist_name || "Unknown") + (a.year ? " - " + a.year : ""),
              imageUrl: coverUrl(a.cover_id, 320),
              action: "view-album",
              targetKind: "album",
              contextMenuActions: [
                { id: "play-playlist", label: "Play Album" },
                { id: "view-album", label: "View Album" },
                { id: "download-album-card", label: "Download Album" },
              ],
            };
          }),
        });
      }
    } else if (state.activeTab === "artists") {
      var artists = state.searchResults.artists || [];
      if (artists.length === 0) {
        children.push({ type: "text", content: "No artists found.", className: "ds-empty" });
      } else {
        children.push({
          type: "card-grid",
          items: artists.map(function (a) {
            return {
              id: "artist:" + a.tidal_id,
              title: a.name,
              imageUrl: coverUrl(a.picture_id, 320),
              action: "view-artist",
              targetKind: "artist",
              contextMenuActions: [
                { id: "view-artist", label: "View Artist" },
              ],
            };
          }),
        });
      }
    }

    api.ui.setViewData("tidal", {
      type: "layout",
      direction: "vertical",
      children: children,
    });
  }

  function renderAlbumDetail() {
    var album = state.albumDetail;
    if (!album) return;

    var trackCount = (album.tracks || []).length;
    var meta = (album.year ? album.year + " \u00B7 " : "") + trackCount + " tracks";

    var children = [
      {
        type: "detail-header",
        title: album.title,
        subtitle: album.artist_name || undefined,
        meta: meta,
        imageUrl: coverUrl(album.cover_id, 640),
        backAction: "go-back",
        actions: [
          { id: "play-album", label: "Play All", icon: "\u25B6" },
          { id: "download-album", label: "Download Album", icon: "\u2B07" },
          { id: "view-album-details", label: "View Details", icon: "\u2139" },
        ],
      },
    ];

    // Track list
    if (album.tracks && album.tracks.length > 0) {
      children.push({
        type: "track-row-list",
        selectable: true,
        actions: [
          { id: "play-selected", label: "Play", icon: "\u25B6" },
          { id: "queue-selected", label: "Queue", icon: "+" },
          { id: "download-selected", label: "Download", icon: "\u2B07" },
        ],
        items: album.tracks.map(function (t) {
          return {
            id: "track:" + t.tidal_id,
            title: (t.track_number ? t.track_number + ". " : "") + t.title,
            subtitle: t.artist_name || album.artist_name || "",
            duration: formatDuration(t.duration_secs),
            action: "play-track",
          };
        }),
      });
    }

    api.ui.setViewData("tidal", {
      type: "layout",
      direction: "vertical",
      children: children,
    });
  }

  function renderArtistDetail() {
    var artist = state.artistDetail;
    if (!artist) return;

    var albumCount = (artist.albums || []).length;
    var children = [
      {
        type: "detail-header",
        title: artist.name,
        meta: albumCount + " album" + (albumCount !== 1 ? "s" : ""),
        imageUrl: coverUrl(artist.picture_id, 640),
        backAction: "go-back",
        actions: [
          { id: "view-artist-details", label: "View Details", icon: "\u2139" },
        ],
      },
    ];

    // Albums
    if (artist.albums && artist.albums.length > 0) {
      children.push({ type: "text", content: "<h3>Discography</h3>" });
      children.push({
        type: "card-grid",
        items: artist.albums.map(function (a) {
          return {
            id: "album:" + a.tidal_id,
            title: a.title,
            subtitle: a.year ? String(a.year) : "",
            imageUrl: coverUrl(a.cover_id, 320),
            action: "view-album",
            targetKind: "album",
            contextMenuActions: [
              { id: "play-playlist", label: "Play Album" },
              { id: "view-album", label: "View Album" },
              { id: "download-album-card", label: "Download Album" },
            ],
          };
        }),
      });
    }

    api.ui.setViewData("tidal", {
      type: "layout",
      direction: "vertical",
      children: children,
    });
  }

  function renderLoading(message) {
    api.ui.setViewData("tidal", { type: "loading", message: message });
  }

  function renderError(message) {
    api.ui.setViewData("tidal", {
      type: "layout",
      direction: "vertical",
      children: [
        { type: "text", content: "<p>" + escapeHtml(message) + "</p>" },
        { type: "button", label: "Retry", action: "retry" },
      ],
    });
  }

  function renderSettings() {
    var serverStatus = "";
    if (!state.apiDown && !state.streamingDown) {
      var count = instanceCache ? instanceCache.apiUrls.length : 0;
      serverStatus = count + " server" + (count !== 1 ? "s" : "") + " online";
    } else if (state.apiDown && state.streamingDown) {
      serverStatus = "servers offline";
    } else if (!state.apiDown) {
      serverStatus = "API online, streaming down";
    } else {
      serverStatus = "API down, streaming online";
    }
    if (state.lastHealthCheck) {
      serverStatus += " — last checked at " + formatTime(state.lastHealthCheck);
    }

    api.ui.setViewData("tidal-settings", {
      type: "layout",
      direction: "vertical",
      children: [
        {
          type: "section",
          title: "Playback",
          children: [
            {
              type: "select",
              label: "Streaming Quality",
              description: "Audio quality for TIDAL playback",
              action: "set-quality",
              value: state.streamingQuality,
              options: [
                { value: "LOW", label: "Low (AAC 96kbps)" },
                { value: "HIGH", label: "High (AAC 320kbps)" },
                { value: "LOSSLESS", label: "Lossless (FLAC 16-bit/44.1kHz)" },
                { value: "HI_RES_LOSSLESS", label: "Hi-Res (FLAC 24-bit/96kHz)" },
              ],
            },
          ],
        },
        {
          type: "section",
          title: "Servers",
          children: [
            {
              type: "settings-row",
              label: "Server Status",
              description: serverStatus,
              control: {
                type: "button",
                label: "Open Status Page",
                action: "open-status-page",
                className: "ds-btn ds-btn--sm ds-btn--secondary",
              },
            },
          ],
        },
      ],
    });
  }

  function render() {
    var anyDown = state.apiDown || state.streamingDown;
    api.ui.setBadge("tidal", anyDown ? { type: "dot", variant: "error" } : null);
    if (state.currentView === "search") renderSearchView();
    else if (state.currentView === "album-detail") renderAlbumDetail();
    else if (state.currentView === "artist-detail") renderArtistDetail();
    renderSettings();
  }

  function escapeHtml(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function findTrackById(tidalId) {
    // Search in current results and album detail
    if (state.searchResults && state.searchResults.tracks) {
      for (var i = 0; i < state.searchResults.tracks.length; i++) {
        if (state.searchResults.tracks[i].tidal_id === tidalId) return state.searchResults.tracks[i];
      }
    }
    if (state.albumDetail && state.albumDetail.tracks) {
      for (var j = 0; j < state.albumDetail.tracks.length; j++) {
        if (state.albumDetail.tracks[j].tidal_id === tidalId) return state.albumDetail.tracks[j];
      }
    }
    return null;
  }

  // -- Actions --

  api.ui.onAction("search", function (data) {
    var query = data && data.query;
    if (!query) return;
    state.lastQuery = query;
    state.activeTab = "tracks";
    renderLoading("Searching TIDAL...");
    tidalSearch(query, 30).then(function (results) {
      state.searchResults = results;
      state.currentView = "search";
      render();
    }).catch(function (err) {
      renderError("Search failed: " + (err.message || err));
    });
  });

  api.ui.onAction("switch-tab", function (data) {
    if (data && data.tabId) {
      state.activeTab = data.tabId;
      render();
    }
  });

  api.ui.onAction("play-track", function (data) {
    if (!data || !data.itemId) return;
    var parts = data.itemId.split(":");
    if (parts[0] !== "track" || !parts[1]) return;
    var track = findTrackById(parts[1]);
    if (track) {
      api.playback.playTidalTrack(track);
    }
  });

  function getSelectedTracks(data) {
    if (!data || !data.selectedIds) return [];
    var tracks = [];
    for (var i = 0; i < data.selectedIds.length; i++) {
      var parts = data.selectedIds[i].split(":");
      if (parts[0] === "track" && parts[1]) {
        var track = findTrackById(parts[1]);
        if (track) tracks.push(track);
      }
    }
    return tracks;
  }

  api.ui.onAction("play-selected", function (data) {
    var tracks = getSelectedTracks(data);
    if (tracks.length > 0) {
      api.playback.playTidalTracks(tracks, 0);
    }
  });

  api.ui.onAction("queue-selected", function (data) {
    var tracks = getSelectedTracks(data);
    for (var i = 0; i < tracks.length; i++) {
      api.playback.enqueueTidalTrack(tracks[i]);
    }
  });

  api.ui.onAction("download-selected", function (data) {
    var tracks = getSelectedTracks(data);
    for (var i = 0; i < tracks.length; i++) {
      api.tidal.downloadTrack(tracks[i].tidal_id).catch(function (err) {
        api.ui.showNotification("Download failed: " + (err.message || err));
      });
    }
    if (tracks.length > 0) {
      api.ui.showNotification("Downloading " + tracks.length + " track" + (tracks.length > 1 ? "s" : ""));
    }
  });

  api.ui.onAction("play-playlist", function (data) {
    if (!data || !data.itemId) return;
    var parts = data.itemId.split(":");
    if (parts[0] !== "album" || !parts[1]) return;
    var albumId = parts[1];
    api.ui.requestAction("show-loading", { message: "Fetching tracks from TIDAL" });
    tidalGetAlbum(albumId).then(function (album) {
      api.ui.requestAction("hide-loading", {});
      if (album && album.tracks && album.tracks.length > 0) {
        api.playback.playTidalTracks(album.tracks, 0, {
          name: album.title + (album.artist_name ? " - " + album.artist_name : ""),
          coverUrl: coverUrl(album.cover_id, 320),
        });
      }
    }).catch(function (err) {
      api.ui.requestAction("hide-loading", {});
      api.ui.showNotification("Failed to play album: " + (err.message || err));
    });
  });

  api.ui.onAction("download-album-card", function (data) {
    if (!data || !data.itemId) return;
    var parts = data.itemId.split(":");
    if (parts[0] !== "album" || !parts[1]) return;
    api.ui.requestAction("show-loading", { message: "Fetching album from TIDAL" });
    tidalGetAlbum(parts[1]).then(function (album) {
      api.ui.requestAction("hide-loading", {});
      if (album) {
        var tracks = (album.tracks || []).map(function (t) {
          return { tidal_id: t.tidal_id, title: t.title, artist_name: t.artist_name || null };
        });
        api.ui.requestAction("tidal-download-album", {
          albumId: album.tidal_id,
          title: album.title,
          artistName: album.artist_name || null,
          coverId: album.cover_id || null,
          trackCount: tracks.length,
          tracks: tracks,
        });
      }
    }).catch(function (err) {
      api.ui.requestAction("hide-loading", {});
      api.ui.showNotification("Failed to load album: " + (err.message || err));
    });
  });

  api.ui.onAction("play-album", function () {
    var album = state.albumDetail;
    if (album && album.tracks && album.tracks.length > 0) {
      api.playback.playTidalTracks(album.tracks, 0, {
        name: album.title + (album.artist_name ? " - " + album.artist_name : ""),
        coverUrl: coverUrl(album.cover_id, 320),
      });
    }
  });

  api.ui.onAction("view-album", function (data) {
    if (!data || !data.itemId) return;
    var parts = data.itemId.split(":");
    if (parts[0] !== "album" || !parts[1]) return;
    var albumId = parts[1];

    state.viewStack.push({
      view: state.currentView,
      activeTab: state.activeTab,
    });

    renderLoading("Loading album...");
    tidalGetAlbum(albumId).then(function (album) {
      state.albumDetail = album;
      state.currentView = "album-detail";
      render();
    }).catch(function (err) {
      renderError("Failed to load album: " + (err.message || err));
    });
  });

  api.ui.onAction("view-artist", function (data) {
    if (!data || !data.itemId) return;
    var parts = data.itemId.split(":");
    if (parts[0] !== "artist" || !parts[1]) return;
    var artistId = parts[1];

    state.viewStack.push({
      view: state.currentView,
      activeTab: state.activeTab,
    });

    renderLoading("Loading artist...");
    tidalGetArtist(artistId).then(function (artist) {
      state.artistDetail = artist;
      state.currentView = "artist-detail";
      render();
    }).catch(function (err) {
      renderError("Failed to load artist: " + (err.message || err));
    });
  });

  api.ui.onAction("go-back", function () {
    if (state.viewStack.length > 0) {
      var prev = state.viewStack.pop();
      state.currentView = prev.view;
      state.activeTab = prev.activeTab;
      render();
    } else {
      state.currentView = "search";
      render();
    }
  });

  api.ui.onAction("view-artist-details", function () {
    var artist = state.artistDetail;
    if (artist) {
      api.ui.requestAction("navigate-to-artist", { name: artist.name });
    }
  });

  api.ui.onAction("view-album-details", function () {
    var album = state.albumDetail;
    if (album) {
      api.ui.requestAction("navigate-to-album", { name: album.title, artistName: album.artist_name || undefined });
    }
  });

  api.ui.onAction("download-track", function (data) {
    if (!data || !data.itemId) return;
    var parts = data.itemId.split(":");
    if (parts[0] !== "track" || !parts[1]) return;
    api.tidal.downloadTrack(parts[1]).catch(function (err) {
      api.ui.showNotification("Download failed: " + (err.message || err));
    });
    api.ui.showNotification("Download started");
  });

  api.ui.onAction("download-album", function () {
    var album = state.albumDetail;
    if (album) {
      var tracks = (album.tracks || []).map(function (t) {
        return { tidal_id: t.tidal_id, title: t.title, artist_name: t.artist_name || null };
      });
      api.ui.requestAction("tidal-download-album", {
        albumId: album.tidal_id,
        title: album.title,
        artistName: album.artist_name || null,
        coverId: album.cover_id || null,
        trackCount: tracks.length,
        tracks: tracks,
      });
    }
  });

  api.ui.onAction("retry", function () {
    if (state.lastQuery) {
      api.ui.onAction("search", { query: state.lastQuery });
    } else {
      state.currentView = "search";
      render();
    }
  });

  // -- Context menu actions --

  api.contextMenu.onAction("search-tidal", function (target) {
    var query = "";
    var tab = "tracks";
    if (target.kind === "track") {
      query = (target.title || "") + " " + (target.artistName || "");
    } else if (target.kind === "album") {
      query = (target.albumTitle || "") + " " + (target.artistName || "");
      tab = "albums";
    } else if (target.kind === "artist") {
      query = target.artistName || "";
      tab = "artists";
    }
    query = query.trim();
    if (!query) return;

    state.lastQuery = query;
    state.activeTab = tab;
    state.viewStack = [];
    state.currentView = "search";
    renderLoading("Searching TIDAL...");
    api.ui.navigateToView("tidal");

    tidalSearch(query, 30).then(function (results) {
      state.searchResults = results;
      state.currentView = "search";
      render();
    }).catch(function (err) {
      renderError("Search failed: " + (err.message || err));
    });
  });

  api.contextMenu.onAction("play-from-tidal", function (target) {
    if (target.kind === "track") {
      var query = ((target.title || "") + " " + (target.artistName || "")).trim();
      if (!query) return;
      tidalSearch(query, 1).then(function (results) {
        var tracks = results.tracks || [];
        if (tracks.length > 0) {
          api.playback.playTidalTrack(tracks[0]);
        } else {
          api.ui.showNotification("No TIDAL match found for this track");
        }
      }).catch(function (err) {
        api.ui.showNotification("TIDAL search failed: " + (err.message || err));
      });
      return;
    }
    if (target.kind === "album") {
      var albumQ = ((target.albumTitle || "") + " " + (target.artistName || "")).trim();
      if (!albumQ) return;
      api.ui.showNotification("Searching TIDAL for album...");
      tidalSearch(albumQ, 1).then(function (results) {
        var albums = (results && results.albums) || [];
        if (albums.length === 0) {
          api.ui.showNotification("No TIDAL match found for this album");
          return;
        }
        return tidalGetAlbum(albums[0].tidal_id).then(function (album) {
          var albumTracks = (album && album.tracks) || [];
          if (albumTracks.length === 0) {
            api.ui.showNotification("TIDAL album has no tracks");
            return;
          }
          api.playback.playTidalTracks(albumTracks, 0);
        });
      }).catch(function (err) {
        api.ui.showNotification("TIDAL album playback failed: " + (err.message || err));
      });
    }
  });

  function downloadTracksViaTidal(tracks, label) {
    if (!tracks || tracks.length === 0) {
      api.ui.showNotification((label || "Playlist") + " is empty");
      return;
    }
    api.ui.showNotification("Queueing TIDAL downloads for " + tracks.length + " track" + (tracks.length > 1 ? "s" : ""));
    tracks.forEach(function (t) {
      var query = ((t.title || "") + " " + (t.artistName || "")).trim();
      if (!query) return;
      tidalSearch(query, 1).then(function (results) {
        var matches = (results && results.tracks) || [];
        if (matches.length === 0) return;
        return api.tidal.downloadTrack(matches[0].tidal_id);
      }).catch(function (err) {
        console.error("TIDAL playlist download failed for track:", t.title, err);
      });
    });
  }

  api.contextMenu.onAction("download-playlist-from-tidal", function (target) {
    if (target.kind !== "playlist") return;
    var label = target.playlistName || "Playlist";
    if (target.playlistId) {
      api.ui.showNotification("Loading playlist tracks...");
      api.playlists.getTracks(target.playlistId).then(function (tracks) {
        downloadTracksViaTidal(tracks, label);
      }).catch(function (err) {
        api.ui.showNotification("Failed to load playlist: " + (err.message || err));
      });
      return;
    }
    if (target.tracks && target.tracks.length > 0) {
      downloadTracksViaTidal(target.tracks, label);
      return;
    }
    api.ui.showNotification("No tracks available for this playlist");
  });

  // -- Download provider --

  api.downloads.onResolve("tidal-download", async function(title, artistName, albumName, sourceTrackId, format) {
    if (state.streamingDown) return null;
    var quality = format === "flac" ? "LOSSLESS" : "HIGH";

    // Direct resolution if we already know the TIDAL track ID
    if (sourceTrackId) {
      try {
        var streamUrl = await tidalGetStreamUrl(sourceTrackId, quality);
        if (streamUrl) {
          return { url: streamUrl, headers: null, metadata: null };
        }
      } catch (e) {
        // Fall through to search
      }
    }

    // Fallback: search by metadata
    var query = [title, artistName].filter(Boolean).join(" ");
    if (!query) return null;

    try {
      var results = await tidalSearch(query, 1);
      var tracks = results && results.tracks;
      if (!tracks || !tracks.length) return null;

      var track = tracks[0];
      var url = await tidalGetStreamUrl(track.tidal_id, quality);
      if (!url) return null;

      return {
        url: url,
        headers: null,
        metadata: {
          title: track.title,
          artist: track.artist_name,
          album: track.album_title,
          trackNumber: track.track_number,
          year: track.year,
          genre: track.genre,
          coverUrl: track.cover_url
        }
      };
    } catch (e) {
      return null;
    }
  });

  // -- Fallback provider --

  function rustLog(level, message) {
    api.informationTypes.invoke("write_frontend_log", { level: level, message: message, section: "tidal" }).catch(function () {});
  }

  api.playback.onStreamResolve("tidal-fallback", async function (title, artistName, albumName) {
    if (state.streamingDown) {
      rustLog("warn", "TIDAL streaming servers are down — skipping stream resolve for: " + [title, artistName].filter(Boolean).join(" — "));
      return null;
    }
    var query = [title, artistName].filter(Boolean).join(" ");
    if (!query) return null;
    try {
      var results = await tidalSearch(query, 1);
      var tracks = results && results.tracks;
      if (tracks && tracks.length > 0) {
        return { url: "tidal://" + tracks[0].tidal_id, label: "TIDAL" };
      }
    } catch (e) {
      // TIDAL unavailable — skip
    }
    return null;
  });

  // -- Download search action --

  api.ui.onAction("tidal-search-for-download", function (data) {
    if (!data || !data.query) return;
    var limit = data.limit || 10;
    tidalSearch(data.query, limit, 0).then(function (results) {
      api.ui.requestAction("tidal-search-result", { tracks: results.tracks });
    }).catch(function (err) {
      api.ui.requestAction("tidal-search-result", { tracks: [], error: String(err.message || err) });
    });
  });

  // -- Stream URL resolver for tidal:// playback --

  api.tidal.onStreamUrlResolve(function (trackId, quality) {
    if (state.streamingDown) {
      rustLog("warn", "TIDAL streaming servers are down — skipping stream URL resolve for track " + trackId);
      return Promise.resolve(null);
    }
    return tidalGetStreamUrl(trackId, quality || state.streamingQuality);
  });

  // -- Resolve stream URL + metadata (for download modal) --

  api.ui.onAction("tidal-resolve-stream", function (data) {
    if (!data || !data.tidalTrackId) return;
    var trackId = data.tidalTrackId;
    var quality = data.quality || "LOSSLESS";
    var requestId = data.requestId || "";
    Promise.all([
      tidalGetStreamUrl(trackId, quality),
      tidalGetTrackInfo(trackId).catch(function () { return null; }),
    ]).then(function (results) {
      var streamUrl = results[0];
      var trackInfo = results[1];
      var trackCoverUrl = null;
      if (trackInfo && trackInfo.cover_id) {
        trackCoverUrl = coverUrl(trackInfo.cover_id, 1280);
      }
      api.ui.requestAction("tidal-stream-resolved", {
        requestId: requestId,
        streamUrl: streamUrl,
        trackInfo: trackInfo,
        coverUrl: trackCoverUrl,
      });
    }).catch(function (err) {
      api.ui.requestAction("tidal-stream-resolved", {
        requestId: requestId,
        streamUrl: null,
        trackInfo: null,
        error: String(err.message || err),
      });
    });
  });

  // Load saved quality setting
  api.storage.get("streaming_quality").then(function (val) {
    if (val) state.streamingQuality = val;
    renderSettings();
  });

  api.ui.onAction("set-quality", function (data) {
    if (data && data.value) {
      state.streamingQuality = data.value;
      api.storage.set("streaming_quality", data.value);
      renderSettings();
    }
  });

  api.ui.onAction("open-status-page", function () {
    api.network.openUrl(UPTIME_URLS[0]);
  });

  api.ui.onAction("check-health", function () {
    instanceCache = null;
    fetchInstances().then(function () {
      render();
    });
  });

  // Health check: immediate + every 30 minutes
  fetchInstances();
  _healthCheckInterval = setInterval(function () {
    instanceCache = null;
    fetchInstances();
  }, CACHE_TTL_MS);

  // Initial render
  render();
}

function deactivate() {
  if (_healthCheckInterval) {
    clearInterval(_healthCheckInterval);
    _healthCheckInterval = null;
  }
}

return { activate: activate, deactivate: deactivate };
