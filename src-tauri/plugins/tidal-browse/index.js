// TIDAL Browse Plugin for Viboplr
// Provides TIDAL search, streaming, and download via plugin system

function activate(api) {
  var state = {
    currentView: "search",
    searchResults: null,
    activeTab: "tracks",
    viewStack: [],
    lastQuery: "",
    albumDetail: null,
    artistDetail: null,
  };

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

  // -- Image providers --

  api.imageProviders.onFetch("artist", async function (name) {
    var results = await api.tidal.search(name, 1);
    var artist = results && results.artists && results.artists[0];
    if (!artist || !artist.picture_id) return { status: "not_found" };
    var url = coverUrl(artist.picture_id, 750);
    return { status: "ok", url: url };
  });

  api.imageProviders.onFetch("album", async function (name, artistName) {
    var query = artistName ? artistName + " " + name : name;
    var results = await api.tidal.search(query, 1);
    var album = results && results.albums && results.albums[0];
    if (!album || !album.cover_id) return { status: "not_found" };
    var url = coverUrl(album.cover_id, 1280);
    return { status: "ok", url: url };
  });

  // -- View rendering --

  function renderSearchView() {
    var children = [
      {
        type: "search-input",
        placeholder: "Search TIDAL...",
        action: "search",
        value: state.lastQuery,
      },
    ];

    if (state.searchResults) {
      var trackCount = (state.searchResults.tracks || []).length;
      var albumCount = (state.searchResults.albums || []).length;
      var artistCount = (state.searchResults.artists || []).length;

      children.push({
        type: "tabs",
        tabs: [
          { id: "tracks", label: "Tracks", count: trackCount },
          { id: "albums", label: "Albums", count: albumCount },
          { id: "artists", label: "Artists", count: artistCount },
        ],
        activeTab: state.activeTab,
        action: "switch-tab",
      });

      if (state.activeTab === "tracks") {
        var tracks = state.searchResults.tracks || [];
        if (tracks.length === 0) {
          children.push({ type: "text", content: "No tracks found." });
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
          children.push({ type: "text", content: "No albums found." });
        } else {
          children.push({
            type: "card-grid",
            items: albums.map(function (a) {
              return {
                id: "album:" + a.tidal_id,
                title: a.title,
                subtitle: (a.artist_name || "Unknown") + (a.year ? " \u2022 " + a.year : ""),
                imageUrl: coverUrl(a.cover_id, 320),
                action: "view-album",
              };
            }),
          });
        }
      } else if (state.activeTab === "artists") {
        var artists = state.searchResults.artists || [];
        if (artists.length === 0) {
          children.push({ type: "text", content: "No artists found." });
        } else {
          children.push({
            type: "card-grid",
            items: artists.map(function (a) {
              return {
                id: "artist:" + a.tidal_id,
                title: a.name,
                imageUrl: coverUrl(a.picture_id, 320),
                action: "view-artist",
              };
            }),
          });
        }
      }
    } else {
      children.push({
        type: "text",
        content: "Search TIDAL for tracks, albums, and artists.",
      });
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

    var children = [
      { type: "button", label: "\u2190 Back", action: "go-back" },
      { type: "spacer" },
    ];

    // Album header
    var headerParts = [];
    headerParts.push("<h2>" + escapeHtml(album.title) + "</h2>");
    if (album.artist_name) headerParts.push("<p>" + escapeHtml(album.artist_name) + (album.year ? " \u2022 " + album.year : "") + "</p>");
    children.push({ type: "text", content: headerParts.join("") });

    // Album cover
    var albumCover = coverUrl(album.cover_id, 640);
    if (albumCover) {
      children.push({
        type: "card-grid",
        columns: 3,
        items: [{ id: "cover", title: "", imageUrl: albumCover }],
      });
    }

    children.push({ type: "spacer" });

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

    children.push({ type: "spacer" });

    // Action buttons
    children.push({
      type: "layout",
      direction: "horizontal",
      children: [
        { type: "button", label: "Play All", action: "play-album" },
        { type: "button", label: "Download Album", action: "download-album" },
      ],
    });

    api.ui.setViewData("tidal", {
      type: "layout",
      direction: "vertical",
      children: children,
    });
  }

  function renderArtistDetail() {
    var artist = state.artistDetail;
    if (!artist) return;

    var children = [
      { type: "button", label: "\u2190 Back", action: "go-back" },
      { type: "spacer" },
    ];

    // Artist header
    children.push({ type: "text", content: "<h2>" + escapeHtml(artist.name) + "</h2>" });

    var artistPic = coverUrl(artist.picture_id, 640);
    if (artistPic) {
      children.push({
        type: "card-grid",
        columns: 3,
        items: [{ id: "pic", title: "", imageUrl: artistPic }],
      });
    }

    children.push({ type: "spacer" });

    // Albums
    if (artist.albums && artist.albums.length > 0) {
      children.push({ type: "text", content: "<h3>Albums</h3>" });
      children.push({
        type: "card-grid",
        items: artist.albums.map(function (a) {
          return {
            id: "album:" + a.tidal_id,
            title: a.title,
            subtitle: a.year ? String(a.year) : "",
            imageUrl: coverUrl(a.cover_id, 320),
            action: "view-album",
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

  function render() {
    if (state.currentView === "search") renderSearchView();
    else if (state.currentView === "album-detail") renderAlbumDetail();
    else if (state.currentView === "artist-detail") renderArtistDetail();
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
    api.tidal.search(query, 30).then(function (results) {
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

  api.ui.onAction("play-album", function () {
    if (state.albumDetail && state.albumDetail.tracks && state.albumDetail.tracks.length > 0) {
      api.playback.playTidalTracks(state.albumDetail.tracks, 0);
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
    api.tidal.getAlbum(albumId).then(function (album) {
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
    api.tidal.getArtist(artistId).then(function (artist) {
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
    if (state.albumDetail) {
      api.tidal.downloadAlbum(state.albumDetail.tidal_id).catch(function (err) {
        api.ui.showNotification("Album download failed: " + (err.message || err));
      });
      api.ui.showNotification("Album download started");
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

    api.tidal.search(query, 30).then(function (results) {
      state.searchResults = results;
      state.currentView = "search";
      render();
    }).catch(function (err) {
      renderError("Search failed: " + (err.message || err));
    });
  });

  api.contextMenu.onAction("download-from-tidal", function (target) {
    if (target.kind === "track") {
      if (target.trackId && target.subsonic) {
        api.ui.showNotification("TIDAL download is only available for local tracks");
        return;
      }
      api.ui.requestAction("tidal-download", {
        trackId: target.trackId || null,
        title: target.title,
        artistName: target.artistName || null,
      });
      return;
    }
    if (target.kind === "album") {
      var albumQuery = ((target.albumTitle || "") + " " + (target.artistName || "")).trim();
      if (!albumQuery) return;
      api.ui.showNotification("Searching TIDAL for album...");
      api.tidal.search(albumQuery, 1).then(function (results) {
        var albums = (results && results.albums) || [];
        if (albums.length === 0) {
          api.ui.showNotification("No TIDAL match found for this album");
          return;
        }
        var albumId = albums[0].tidal_id;
        api.tidal.downloadAlbum(albumId).catch(function (err) {
          api.ui.showNotification("Album download failed: " + (err.message || err));
        });
        api.ui.showNotification("Album download started");
      }).catch(function (err) {
        api.ui.showNotification("TIDAL search failed: " + (err.message || err));
      });
    }
  });

  api.contextMenu.onAction("play-from-tidal", function (target) {
    if (target.kind === "track") {
      var query = ((target.title || "") + " " + (target.artistName || "")).trim();
      if (!query) return;
      api.tidal.search(query, 1).then(function (results) {
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
      api.tidal.search(albumQ, 1).then(function (results) {
        var albums = (results && results.albums) || [];
        if (albums.length === 0) {
          api.ui.showNotification("No TIDAL match found for this album");
          return;
        }
        return api.tidal.getAlbum(albums[0].tidal_id).then(function (album) {
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
      api.tidal.search(query, 1).then(function (results) {
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

  // -- Fallback provider --

  api.playback.onFallbackResolve("tidal-fallback", async function (title, artistName, albumName) {
    var query = [title, artistName].filter(Boolean).join(" ");
    if (!query) return null;
    try {
      var results = await api.tidal.search(query, 1);
      var tracks = results && results.tracks;
      if (tracks && tracks.length > 0) {
        return { url: "tidal://" + tracks[0].tidal_id, label: "TIDAL" };
      }
    } catch (e) {
      // TIDAL unavailable — skip
    }
    return null;
  });

  // Initial render
  render();
}

function deactivate() {
  // Nothing to clean up
}

return { activate: activate, deactivate: deactivate };
