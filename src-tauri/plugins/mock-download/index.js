// Mock Download Provider Plugin
// For testing the download system without real services.
// Returns fake search results and downloads free CC-licensed MP3 files from SoundHelix.

function activate(api) {
  var MOCK_CATALOG = [
    { id: "mock-1", title: "Bohemian Rhapsody", artistName: "Queen", albumTitle: "A Night at the Opera", durationSecs: 354, trackNumber: 1 },
    { id: "mock-2", title: "Stairway to Heaven", artistName: "Led Zeppelin", albumTitle: "Led Zeppelin IV", durationSecs: 482, trackNumber: 4 },
    { id: "mock-3", title: "Hotel California", artistName: "Eagles", albumTitle: "Hotel California", durationSecs: 391, trackNumber: 1 },
    { id: "mock-4", title: "Comfortably Numb", artistName: "Pink Floyd", albumTitle: "The Wall", durationSecs: 382, trackNumber: 6 },
    { id: "mock-5", title: "Imagine", artistName: "John Lennon", albumTitle: "Imagine", durationSecs: 187, trackNumber: 1 },
    { id: "mock-6", title: "Yesterday", artistName: "The Beatles", albumTitle: "Help!", durationSecs: 125, trackNumber: 13 },
    { id: "mock-7", title: "Smells Like Teen Spirit", artistName: "Nirvana", albumTitle: "Nevermind", durationSecs: 301, trackNumber: 1 },
    { id: "mock-8", title: "Wish You Were Here", artistName: "Pink Floyd", albumTitle: "Wish You Were Here", durationSecs: 334, trackNumber: 5 },
    { id: "mock-9", title: "Sweet Child O' Mine", artistName: "Guns N' Roses", albumTitle: "Appetite for Destruction", durationSecs: 356, trackNumber: 9 },
    { id: "mock-10", title: "Paranoid", artistName: "Black Sabbath", albumTitle: "Paranoid", durationSecs: 172, trackNumber: 1 },
  ];

  // SoundHelix provides free CC-licensed MP3 files for testing
  var STREAM_URLS = [
    "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
    "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3",
    "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3",
    "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3",
    "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3",
    "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3",
    "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3",
    "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3",
    "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-9.mp3",
    "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-10.mp3",
  ];

  var state = {
    enabled: true,
    resolveDelayMs: 500,
    failRate: 0,
    errorRate: 0,
    emptySearchRate: 0,
  };

  function getStreamUrl(mockId) {
    var idx = parseInt(mockId.replace("mock-", ""), 10) - 1;
    if (idx < 0 || idx >= STREAM_URLS.length) idx = 0;
    return STREAM_URLS[idx];
  }

  function shouldFail() {
    return state.failRate > 0 && Math.random() < state.failRate;
  }

  function shouldError() {
    return state.errorRate > 0 && Math.random() < state.errorRate;
  }

  function shouldEmptySearch() {
    return state.emptySearchRate > 0 && Math.random() < state.emptySearchRate;
  }

  function delay(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
  }

  // -- Download provider: silent (queue-based) --

  api.downloads.onResolveByUri("mock-dl", async function(uri, format) {
    if (!state.enabled) return null;
    if (!uri || !uri.startsWith("mock://")) return null;
    if (shouldError()) throw new Error("Mock provider: simulated error on URI resolve");
    if (shouldFail()) return null;
    await delay(state.resolveDelayMs);
    var mockId = uri.substring(7);
    var track = MOCK_CATALOG.find(function(t) { return t.id === mockId; });
    return {
      url: getStreamUrl(mockId),
      headers: null,
      metadata: track ? {
        title: track.title,
        artist: track.artistName,
        album: track.albumTitle,
        trackNumber: track.trackNumber,
      } : null,
    };
  });

  api.downloads.onResolveByMetadata("mock-dl", async function(title, artistName, albumName, durationSecs, format) {
    if (!state.enabled) return null;
    if (shouldError()) throw new Error("Mock provider: simulated error on metadata resolve");
    if (shouldFail()) return null;
    await delay(state.resolveDelayMs);
    var q = (title || "").toLowerCase();
    var a = (artistName || "").toLowerCase();
    var match = MOCK_CATALOG.find(function(t) {
      return t.title.toLowerCase().indexOf(q) >= 0 ||
        (a && t.artistName.toLowerCase().indexOf(a) >= 0);
    });
    if (!match) return null;
    return {
      url: getStreamUrl(match.id),
      headers: null,
      metadata: {
        title: match.title,
        artist: match.artistName,
        album: match.albumTitle,
        trackNumber: match.trackNumber,
      },
    };
  });

  // -- Interactive download mode --

  api.downloads.onInteractiveSearch("mock-dl", async function(query, limit) {
    if (!state.enabled) return [];
    await delay(state.resolveDelayMs);
    if (shouldError()) throw new Error("Mock provider: simulated search error");
    if (shouldEmptySearch()) return [];
    var q = (query || "").toLowerCase();
    var results = MOCK_CATALOG.filter(function(t) {
      return t.title.toLowerCase().indexOf(q) >= 0 ||
        t.artistName.toLowerCase().indexOf(q) >= 0 ||
        t.albumTitle.toLowerCase().indexOf(q) >= 0;
    });
    if (results.length === 0) {
      results = MOCK_CATALOG.slice(0, Math.min(limit || 5, MOCK_CATALOG.length));
    }
    return results.slice(0, limit || 10).map(function(t) {
      return {
        id: t.id,
        title: t.title,
        artistName: t.artistName,
        albumTitle: t.albumTitle,
        coverUrl: null,
        durationSecs: t.durationSecs,
        trackNumber: t.trackNumber,
      };
    });
  });

  api.downloads.onInteractiveResolve("mock-dl", async function(matchId, format) {
    if (!state.enabled) throw new Error("Mock provider disabled");
    if (shouldError()) throw new Error("Mock provider: simulated resolve error");
    if (shouldFail()) throw new Error("Mock provider: simulated resolve failure");
    await delay(state.resolveDelayMs);
    var track = MOCK_CATALOG.find(function(t) { return t.id === matchId; });
    if (!track) throw new Error("Mock track not found: " + matchId);
    return {
      url: getStreamUrl(matchId),
      headers: null,
      metadata: {
        title: track.title,
        artist: track.artistName,
        album: track.albumTitle,
        trackNumber: track.trackNumber,
      },
    };
  });

  // -- Settings panel --

  function renderSettings() {
    api.ui.setViewData("mock-download-settings", {
      type: "layout",
      direction: "vertical",
      children: [
        {
          type: "section",
          title: "Mock Provider",
          children: [
            {
              type: "settings-row",
              label: "Enabled",
              description: "When disabled, the mock provider returns null for all requests",
              control: { type: "toggle", checked: state.enabled, action: "toggle-enabled" },
            },
            {
              type: "settings-row",
              label: "Resolve Delay",
              description: "Simulated network delay in milliseconds",
              control: {
                type: "select",
                value: String(state.resolveDelayMs),
                action: "set-delay",
                options: [
                  { value: "0", label: "None (0ms)" },
                  { value: "500", label: "Fast (500ms)" },
                  { value: "2000", label: "Slow (2s)" },
                  { value: "5000", label: "Very slow (5s)" },
                ],
              },
            },
            {
              type: "settings-row",
              label: "Failure Rate",
              description: "Probability of returning null (silent failure, falls through to next provider)",
              control: {
                type: "select",
                value: String(state.failRate),
                action: "set-fail-rate",
                options: [
                  { value: "0", label: "Never" },
                  { value: "0.25", label: "25%" },
                  { value: "0.5", label: "50%" },
                  { value: "1", label: "Always" },
                ],
              },
            },
            {
              type: "settings-row",
              label: "Error Rate",
              description: "Probability of throwing an error (shown to user)",
              control: {
                type: "select",
                value: String(state.errorRate),
                action: "set-error-rate",
                options: [
                  { value: "0", label: "Never" },
                  { value: "0.25", label: "25%" },
                  { value: "0.5", label: "50%" },
                  { value: "1", label: "Always" },
                ],
              },
            },
            {
              type: "settings-row",
              label: "Empty Search Rate",
              description: "Probability of returning no search results in interactive mode",
              control: {
                type: "select",
                value: String(state.emptySearchRate),
                action: "set-empty-search-rate",
                options: [
                  { value: "0", label: "Never" },
                  { value: "0.25", label: "25%" },
                  { value: "0.5", label: "50%" },
                  { value: "1", label: "Always" },
                ],
              },
            },
          ],
        },
        {
          type: "section",
          title: "Info",
          children: [
            {
              type: "text",
              content: "This plugin provides " + MOCK_CATALOG.length + " fake tracks for testing the download system. " +
                "Downloads use free CC-licensed MP3 files from SoundHelix. " +
                "Supports both silent (queue-based) and interactive (modal) downloads.",
            },
          ],
        },
      ],
    });
  }

  api.ui.onAction("toggle-enabled", function(data) {
    state.enabled = !!data.value;
    api.storage.set("enabled", state.enabled);
    renderSettings();
  });

  api.ui.onAction("set-delay", function(data) {
    state.resolveDelayMs = parseInt(data.value, 10) || 0;
    api.storage.set("resolve_delay_ms", state.resolveDelayMs);
    renderSettings();
  });

  api.ui.onAction("set-fail-rate", function(data) {
    state.failRate = parseFloat(data.value) || 0;
    api.storage.set("fail_rate", state.failRate);
    renderSettings();
  });

  api.ui.onAction("set-error-rate", function(data) {
    state.errorRate = parseFloat(data.value) || 0;
    api.storage.set("error_rate", state.errorRate);
    renderSettings();
  });

  api.ui.onAction("set-empty-search-rate", function(data) {
    state.emptySearchRate = parseFloat(data.value) || 0;
    api.storage.set("empty_search_rate", state.emptySearchRate);
    renderSettings();
  });

  // Load saved settings
  Promise.all([
    api.storage.get("enabled"),
    api.storage.get("resolve_delay_ms"),
    api.storage.get("fail_rate"),
    api.storage.get("error_rate"),
    api.storage.get("empty_search_rate"),
  ]).then(function(values) {
    if (values[0] === false) state.enabled = false;
    if (values[1] != null) state.resolveDelayMs = parseInt(values[1], 10) || 0;
    if (values[2] != null) state.failRate = parseFloat(values[2]) || 0;
    if (values[3] != null) state.errorRate = parseFloat(values[3]) || 0;
    if (values[4] != null) state.emptySearchRate = parseFloat(values[4]) || 0;
    renderSettings();
  });

  renderSettings();
}

function deactivate() {}

return { activate: activate, deactivate: deactivate };
