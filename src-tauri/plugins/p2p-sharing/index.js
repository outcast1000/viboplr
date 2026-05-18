// P2P Sharing Plugin for Viboplr
// Supabase for peer discovery, libp2p for search and file transfer

var heartbeatInterval = null;
var peerCountInterval = null;

var CONFIG_KEYS = {
  enabled: "p2p_enabled",
  supabaseUrl: "p2p_supabase_url",
  supabaseKey: "p2p_supabase_key",
  relayMultiaddr: "p2p_relay_multiaddr",
  sharedCollections: "p2p_shared_collections",
  maxPeers: "p2p_max_peers",
};

var DEFAULT_SUPABASE_URL = "https://jyosmcvtyfvrajvffqyi.supabase.co";
var DEFAULT_SUPABASE_KEY = "sb_publishable_ZVIAR8SJ8nLvUnrN-arjDw_LkD5spiX";

function activate(api) {
  var state = {
    enabled: false,
    online: false,
    peerId: null,
    multiaddrs: [],
    canRelay: false,
    searching: false,
    searchResults: [],
    lastQuery: "",
    peerCount: 0,
    error: null,
    config: {
      supabaseUrl: DEFAULT_SUPABASE_URL,
      supabaseKey: DEFAULT_SUPABASE_KEY,
      relayMultiaddr: "",
      sharedCollections: [],
      maxPeers: 50,
    },
    collections: [],
  };

  // --- Config management ---

  function loadConfig() {
    return Promise.all([
      api.storage.get(CONFIG_KEYS.enabled),
      api.storage.get(CONFIG_KEYS.supabaseUrl),
      api.storage.get(CONFIG_KEYS.supabaseKey),
      api.storage.get(CONFIG_KEYS.relayMultiaddr),
      api.storage.get(CONFIG_KEYS.sharedCollections),
      api.storage.get(CONFIG_KEYS.maxPeers),
    ]).then(function (values) {
      state.enabled = values[0] === null ? true : values[0]; // default ON
      state.config.supabaseUrl = values[1] || DEFAULT_SUPABASE_URL;
      state.config.supabaseKey = values[2] || DEFAULT_SUPABASE_KEY;
      state.config.relayMultiaddr = values[3] || "";
      state.config.sharedCollections = values[4] || [];
      state.config.maxPeers = values[5] || 50;
    });
  }

  function saveConfig(key, value) {
    return api.storage.set(key, value);
  }

  // --- Supabase interactions ---

  function supabaseFetch(method, path, body) {
    var url = state.config.supabaseUrl + "/rest/v1" + path;
    var headers = {
      apikey: state.config.supabaseKey,
      Authorization: "Bearer " + state.config.supabaseKey,
      "Content-Type": "application/json",
    };
    if (method === "POST") {
      headers["Prefer"] = "resolution=merge-duplicates";
    }
    var opts = { method: method, headers: headers };
    if (body) opts.body = JSON.stringify(body);
    return api.network.fetch(url, opts);
  }

  function heartbeat() {
    if (!state.online || !state.config.supabaseUrl || !state.peerId) return;

    supabaseFetch("POST", "/devices", {
      peer_id: state.peerId,
      multiaddrs: state.multiaddrs,
      can_relay: state.canRelay,
      app_version: "0.9.78",
      shared_track_count: state.trackCount || 0,
      last_seen: new Date().toISOString(),
    }).catch(function (e) {
      api.log("warn", "P2P heartbeat failed: " + e);
    });
  }

  function updateTrackCount() {
    api.library.getTrackCount().then(function (count) {
      state.trackCount = count || 0;
    }).catch(function () {});
  }

  function removePresence() {
    if (!state.peerId || !state.config.supabaseUrl) return;
    return supabaseFetch(
      "DELETE",
      "/devices?peer_id=eq." + encodeURIComponent(state.peerId)
    ).catch(function () {});
  }

  function queryPeers(limit) {
    var exclusion = state.peerId
      ? "&peer_id=neq." + encodeURIComponent(state.peerId)
      : "";
    return supabaseFetch(
      "GET",
      "/devices?select=peer_id,multiaddrs&order=last_seen.desc&limit=" +
        limit + exclusion
    ).then(function (resp) {
      return resp.json();
    });
  }

  function countPeers() {
    if (!state.config.supabaseUrl || !state.online) return;
    var exclusion = state.peerId
      ? "&peer_id=neq." + encodeURIComponent(state.peerId)
      : "";
    supabaseFetch(
      "GET",
      "/devices?select=peer_id" + exclusion
    ).then(function (resp) {
      return resp.json();
    }).then(function (rows) {
      var count = rows ? rows.length : 0;
      if (count !== state.peerCount) {
        state.peerCount = count;
        renderView();
      }
    }).catch(function () {});
  }

  // --- Search ---

  var searchGeneration = 0; // increments on each search, used to cancel stale results

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; resolve(null); }
      }, ms);
      promise.then(function (v) {
        if (!done) { done = true; clearTimeout(timer); resolve(v); }
      }).catch(function () {
        if (!done) { done = true; clearTimeout(timer); resolve(null); }
      });
    });
  }

  function cancelSearch() {
    searchGeneration++;
    state.searching = false;
    state.error = state.searchResults.length > 0
      ? null
      : "Search cancelled";
    renderView();
  }

  function search(query) {
    if (!query) {
      state.searchResults = [];
      state.lastQuery = "";
      state.error = null;
      renderView();
      return;
    }

    if (!state.online) {
      state.error = "P2P node is not connected";
      renderView();
      return;
    }

    // Cancel any in-flight search
    searchGeneration++;
    var thisGeneration = searchGeneration;

    state.searching = true;
    state.lastQuery = query;
    state.searchResults = [];
    state.error = null;
    renderView();

    var PEER_TIMEOUT = 5000; // 5s per peer

    queryPeers(state.config.maxPeers)
      .then(function (peers) {
        if (thisGeneration !== searchGeneration) return; // cancelled

        if (!peers || peers.length === 0) {
          state.searching = false;
          state.error = "No peers online. Share the app with someone!";
          renderView();
          return;
        }

        api.log("info", "P2P: Found " + peers.length + " peers, searching for '" + query + "'");
        peers.forEach(function (p) {
          api.log("info", "P2P:   peer=" + (p.peer_id || "?").substring(0, 12) + "... addr=" + (p.multiaddrs && p.multiaddrs[0] || "none"));
        });

        var promises = peers.map(function (peer) {
          var addr = peer.multiaddrs && peer.multiaddrs[0] ? peer.multiaddrs[0] : "";
          if (!addr) {
            api.log("warn", "P2P: Skipping peer with no address: " + peer.peer_id);
            return Promise.resolve(null);
          }

          api.log("info", "P2P: Querying peer " + peer.peer_id.substring(0, 12) + "...");
          return withTimeout(
            api.p2p.searchPeer(peer.peer_id, addr, query, 20)
              .then(function (result) {
                api.log("info", "P2P: Peer " + peer.peer_id.substring(0, 12) + "... returned " + (result && result.matches ? result.matches.length : 0) + " matches");
                return result;
              })
              .catch(function (e) {
                api.log("warn", "P2P: Peer " + peer.peer_id.substring(0, 12) + "... error: " + e);
                return null;
              }),
            PEER_TIMEOUT
          ).then(function (result) {
            if (result === null) {
              api.log("warn", "P2P: Peer " + peer.peer_id.substring(0, 12) + "... timed out or failed");
            }
            return result;
          });
        });

        return Promise.all(promises);
      })
      .then(function (responses) {
        if (thisGeneration !== searchGeneration) return; // cancelled
        if (!responses) return;

        var allMatches = [];
        var peersResponded = 0;
        responses.forEach(function (resp) {
          if (resp && resp.matches && resp.matches.length > 0) {
            peersResponded++;
            resp.matches.forEach(function (m) {
              m._peerId = resp.peer_id;
              m._multiaddr = "";
              allMatches.push(m);
            });
          }
        });

        // Deduplicate by title+artist
        var seen = {};
        state.searchResults = allMatches.filter(function (m) {
          var key = (m.title || "").toLowerCase() + "|" + (m.artist_name || "").toLowerCase();
          if (seen[key]) return false;
          seen[key] = true;
          return true;
        });

        state.searching = false;
        if (state.searchResults.length === 0) {
          state.error = "No results from " + responses.length + " peers";
        }
        api.log("info", "P2P: Found " + state.searchResults.length + " tracks from " + peersResponded + " peers");
        renderView();
      })
      .catch(function (e) {
        if (thisGeneration !== searchGeneration) return; // cancelled
        state.searching = false;
        state.error = "Search failed: " + e;
        api.log("error", "P2P search error: " + e);
        renderView();
      });
  }

  // --- UI rendering ---

  function formatDuration(secs) {
    if (!secs) return "";
    var m = Math.floor(secs / 60);
    var s = Math.floor(secs % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function renderView() {
    // Connecting
    if (!state.online) {
      var connectChildren = [
        { type: "toolbar", title: "P2P Sharing", status: "Connecting...", buttons: [] },
        { type: "loading", message: "Starting P2P node..." },
      ];
      if (state.error) {
        connectChildren = [
          { type: "toolbar", title: "P2P Sharing", status: "Offline", buttons: [
            { label: "Retry", action: "p2p-connect" },
          ] },
          { type: "spacer" },
          { type: "text", content: state.error, className: "secondary" },
        ];
      }
      api.ui.setViewData("p2p", {
        type: "layout",
        direction: "vertical",
        children: connectChildren,
      });
      return;
    }

    var children = [];

    // Status toolbar — always visible
    var statusText = state.peerCount > 0
      ? state.peerCount + " peer" + (state.peerCount > 1 ? "s" : "") + " online"
      : "No peers online";
    children.push({
      type: "toolbar",
      title: "P2P Sharing",
      status: statusText,
      buttons: [
        { label: "Disconnect", action: "p2p-toggle-enabled" },
      ],
    });

    // Search input
    children.push({
      type: "search-input",
      placeholder: "Search the network...",
      action: "p2p-search",
      value: state.lastQuery,
    });

    // Search state
    if (state.searching) {
      children.push({
        type: "layout",
        direction: "horizontal",
        children: [
          { type: "loading", message: "Searching peers..." },
          { type: "button", label: "Cancel", action: "p2p-cancel-search" },
        ],
      });
    } else if (state.searchResults.length > 0) {
      // Results as track list
      var tracks = state.searchResults.map(function (m) {
        return {
          path: "p2p://" + encodeURIComponent(m._peerId || "unknown") + "/" + encodeURIComponent(m._multiaddr || "") + "/" + m.track_id,
          title: m.title,
          artist_name: m.artist_name || "Unknown Artist",
          album_title: m.album_title || "",
          duration_secs: m.duration_secs,
          format: m.format,
        };
      });
      children.push({
        type: "track-list",
        tracks: tracks,
        context: { name: "P2P: " + state.lastQuery },
      });
    } else if (state.error) {
      children.push({ type: "spacer" });
      children.push({ type: "text", content: state.error, className: "secondary" });
    } else if (!state.lastQuery) {
      // Empty state
      children.push({ type: "spacer" });
      if (state.peerCount > 0) {
        children.push({ type: "text", content: state.peerCount + " peer" + (state.peerCount > 1 ? "s" : "") + " available. Type a song or artist name to search.", className: "secondary" });
      } else {
        children.push({ type: "text", content: "No other peers online yet. Share the app with someone!", className: "secondary" });
      }
    }

    api.ui.setViewData("p2p", {
      type: "layout",
      direction: "vertical",
      children: children,
    });
  }

  function renderSettings() {
    var settingsChildren = [];

    // Connection section
    settingsChildren.push({
      type: "section",
      title: "Connection",
      children: [
        {
          type: "settings-row",
          label: "P2P Sharing",
          description: state.online
            ? "Connected as " + (state.peerId ? state.peerId.substring(0, 16) + "..." : "unknown")
            : "Disconnected",
          child: { type: "toggle", checked: state.enabled, action: "p2p-toggle-enabled" },
        },
      ],
    });

    // Sharing info — all local collections are shared
    if (state.collections.length > 0) {
      settingsChildren.push({
        type: "section",
        title: "Sharing",
        children: [
          {
            type: "settings-row",
            label: "All local collections are shared",
            description: state.collections.length + " collection" + (state.collections.length > 1 ? "s" : "") + " available to peers on the network",
          },
        ],
      });
    }

    // Advanced section
    settingsChildren.push({
      type: "section",
      title: "Advanced",
      children: [
        {
          type: "settings-row",
          label: "Discovery Server",
          description: "Supabase project URL for peer discovery",
          child: { type: "text-input", value: state.config.supabaseUrl, placeholder: "https://xxx.supabase.co", action: "p2p-set-supabase-url" },
        },
        {
          type: "settings-row",
          label: "Discovery Key",
          description: "Public API key for the discovery server",
          child: { type: "text-input", value: state.config.supabaseKey, placeholder: "sb_...", action: "p2p-set-supabase-key" },
        },
        {
          type: "settings-row",
          label: "Relay Address",
          description: "Public relay for NAT traversal (leave empty for volunteer relays)",
          child: { type: "text-input", value: state.config.relayMultiaddr, placeholder: "/ip4/.../udp/.../quic-v1/p2p/...", action: "p2p-set-relay" },
        },
        {
          type: "settings-row",
          label: "Max Peers Per Search",
          description: "Number of peers to query on each search (1-100)",
          child: { type: "text-input", value: String(state.config.maxPeers), action: "p2p-set-max-peers" },
        },
      ],
    });

    api.ui.setViewData("p2p-settings", {
      type: "layout",
      direction: "vertical",
      children: settingsChildren,
    });
  }

  // --- Action handlers ---

  api.ui.onAction("p2p-connect", function () {
    state.error = null;
    // Show a connecting state immediately
    api.ui.setViewData("p2p", {
      type: "layout",
      direction: "vertical",
      children: [
        { type: "toolbar", title: "P2P Sharing", status: "Connecting...", buttons: [] },
        { type: "loading", message: "Starting P2P node..." },
      ],
    });
    initialize();
  });

  api.ui.onAction("p2p-search", function (payload) {
    var query = typeof payload === "string" ? payload : (payload && (payload.query || payload.value)) || "";
    search(query);
  });

  api.ui.onAction("p2p-cancel-search", function () {
    cancelSearch();
  });

  api.ui.onAction("p2p-toggle-enabled", function () {
    state.enabled = !state.enabled;
    saveConfig(CONFIG_KEYS.enabled, state.enabled);
    if (state.enabled) {
      initialize();
    } else {
      shutdown();
    }
    renderSettings();
    renderView();
  });

  api.ui.onAction("p2p-set-supabase-url", function (payload) {
    state.config.supabaseUrl = (payload && payload.value) || "";
    saveConfig(CONFIG_KEYS.supabaseUrl, state.config.supabaseUrl);
  });

  api.ui.onAction("p2p-set-supabase-key", function (payload) {
    state.config.supabaseKey = (payload && payload.value) || "";
    saveConfig(CONFIG_KEYS.supabaseKey, state.config.supabaseKey);
  });

  api.ui.onAction("p2p-set-relay", function (payload) {
    state.config.relayMultiaddr = (payload && payload.value) || "";
    saveConfig(CONFIG_KEYS.relayMultiaddr, state.config.relayMultiaddr);
  });

  api.ui.onAction("p2p-set-max-peers", function (payload) {
    var val = parseInt((payload && payload.value) || "50", 10);
    if (val >= 1 && val <= 100) {
      state.config.maxPeers = val;
      saveConfig(CONFIG_KEYS.maxPeers, val);
    }
  });


  // --- Stream resolver ---

  api.playback.onResolveStreamByUri("p2p", function (id) {
    var parts = id.split("/");
    var peerId, trackId, multiaddr;
    if (parts.length >= 3) {
      peerId = decodeURIComponent(parts[0]);
      multiaddr = decodeURIComponent(parts[1]);
      trackId = parts.slice(2).join("/");
    } else {
      peerId = decodeURIComponent(parts[0]);
      trackId = parts[1] || "";
      multiaddr = "";
    }

    return api.p2p
      .streamFromPeer(peerId, multiaddr, trackId)
      .then(function (url) {
        return { url: url, label: "P2P" };
      });
  });

  // --- Context menu: download from peer ---

  api.contextMenu.onAction("p2p-download", function (target) {
    if (!target || !target.path || !target.path.startsWith("p2p://")) return;
    var uri = target.path.replace("p2p://", "");
    var parts = uri.split("/");
    var peerId = decodeURIComponent(parts[0]);
    var multiaddr = parts.length >= 3 ? decodeURIComponent(parts[1]) : "";
    var trackId = parts.length >= 3 ? parts.slice(2).join("/") : (parts[1] || "");

    // Use the first shared collection as destination, or first local collection
    var destId = state.config.sharedCollections[0];
    if (!destId && state.collections.length > 0) {
      destId = state.collections[0].id;
    }
    if (!destId) {
      api.log("warn", "P2P: No local collection to download into");
      return;
    }

    api.log("info", "P2P: Downloading track from peer " + peerId.substring(0, 12) + "...");
    api.p2p.downloadFromPeer(peerId, multiaddr, trackId, destId)
      .then(function () {
        api.log("info", "P2P: Download complete");
      })
      .catch(function (e) {
        api.log("error", "P2P: Download failed: " + e);
      });
  });

  // --- Lifecycle ---

  function initialize() {
    state.error = null;
    renderView(); // show "connecting" state

    var relay = state.config.relayMultiaddr || null;
    api.p2p
      .start(relay)
      .then(function (status) {
        api.log("info", "P2P: start() returned: " + JSON.stringify(status));
        // Treat any non-error response as success — the node is running
        state.online = true;
        if (status) {
          state.peerId = status.peer_id || "";
          state.multiaddrs = status.multiaddrs || [];
          state.canRelay = status.can_relay || false;
        }
        renderView();
        renderSettings();

        // Get track count then start heartbeat
        updateTrackCount();
        heartbeat();
        heartbeatInterval = setInterval(heartbeat, 60000);

        // Start peer count polling
        countPeers();
        peerCountInterval = setInterval(countPeers, 30000);

        // Set shared collections
        if (state.config.sharedCollections.length > 0) {
          api.p2p.setSharedCollections(state.config.sharedCollections).catch(function () {});
        }

        // Poll for status update (multiaddrs may come in slightly later)
        setTimeout(function () {
          api.p2p.getStatus().then(function (s) {
            if (s && s.status === "online") {
              state.peerId = s.peer_id;
              state.multiaddrs = s.multiaddrs || [];
              state.canRelay = s.can_relay || false;
              renderView();
              renderSettings();
              heartbeat(); // re-heartbeat with updated addrs
            }
          }).catch(function () {});
        }, 2000);
      })
      .catch(function (e) {
        var msg = String(e);
        // If already running, just get the current status
        if (msg.indexOf("already running") >= 0) {
          api.log("info", "P2P: Node already running, fetching status");
          return api.p2p.getStatus().then(function (s) {
            state.online = true;
            if (s) {
              state.peerId = s.peer_id || "";
              state.multiaddrs = s.multiaddrs || [];
              state.canRelay = s.can_relay || false;
            }
            renderView();
            renderSettings();
            heartbeat();
            heartbeatInterval = setInterval(heartbeat, 60000);
            countPeers();
            peerCountInterval = setInterval(countPeers, 30000);
          });
        }
        state.error = "Failed to start: " + msg;
        api.log("error", "P2P: " + state.error);
        state.online = false;
        renderView();
      });
  }

  function shutdown() {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (peerCountInterval) {
      clearInterval(peerCountInterval);
      peerCountInterval = null;
    }
    removePresence();
    api.p2p.stop().catch(function () {});
    state.online = false;
    state.peerId = null;
    state.multiaddrs = [];
    state.peerCount = 0;
    state.searchResults = [];
    state.error = null;
  }

  // --- Startup ---

  loadConfig().then(function () {
    // Load collections and auto-share all of them
    try {
      if (api.collections && api.collections.getLocalCollections) {
        api.collections.getLocalCollections().then(function (cols) {
          state.collections = cols || [];

          // Always share all local collections
          state.config.sharedCollections = state.collections.map(function (c) { return c.id; });
          if (state.online) {
            api.p2p.setSharedCollections(state.config.sharedCollections).catch(function () {});
          }

          renderSettings();
        }).catch(function (e) {
          api.log("warn", "P2P: Failed to load collections: " + e);
        });
      }
    } catch (e) {
      api.log("warn", "P2P: collections API not available");
    }

    renderSettings();
    renderView();

    // Auto-connect on plugin activation
    initialize();
  }).catch(function (e) {
    api.log("error", "P2P: Plugin startup failed: " + e);
  });
}

function deactivate() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (peerCountInterval) {
    clearInterval(peerCountInterval);
    peerCountInterval = null;
  }
}

return { activate: activate, deactivate: deactivate };
