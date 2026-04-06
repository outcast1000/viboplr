// Injected via Playwright's addInitScript before the app loads.
// Mocks the Tauri IPC layer so the frontend renders in a regular browser.

window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
window.__TAURI_EVENT_PLUGIN_INTERNALS__ =
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};

// Mock window metadata (required by @tauri-apps/api/window)
window.__TAURI_INTERNALS__.metadata = {
  currentWindow: { label: 'main' },
  currentWebview: { windowLabel: 'main', label: 'main' },
};

// Mock convertFileSrc — return a tiny silent WAV data URI so the browser
// can actually load/play it (asset:// URLs don't work outside Tauri).
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
window.__TAURI_INTERNALS__.convertFileSrc = function (_filePath, _protocol) {
  return SILENT_WAV;
};

// Callback registry (used by event system)
const callbacks = new Map();

window.__TAURI_INTERNALS__.transformCallback = function (callback, once) {
  const id = Math.floor(Math.random() * 0xffffffff);
  callbacks.set(id, function (data) {
    if (once) callbacks.delete(id);
    return callback && callback(data);
  });
  return id;
};

window.__TAURI_INTERNALS__.unregisterCallback = function (id) {
  callbacks.delete(id);
};

window.__TAURI_INTERNALS__.runCallback = function (id, data) {
  const cb = callbacks.get(id);
  if (cb) cb(data);
};

window.__TAURI_INTERNALS__.callbacks = callbacks;

// Event listener tracking
const eventListeners = new Map();

window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function (
  event,
  id
) {
  callbacks.delete(id);
};

// Test tracks for library
const TEST_TRACKS = [
  { id: 1, path: 'file:///music/Artist A/Album X/01 First Song.flac', title: 'First Song', artist_id: 1, artist_name: 'Artist A', album_id: 1, album_title: 'Album X', year: 2020, track_number: 1, duration_secs: 210, format: 'flac', file_size: 30000000, collection_id: 1, collection_name: 'Music', liked: 0, youtube_url: null, added_at: 1700000000, modified_at: 1700000000 },
  { id: 2, path: 'file:///music/Artist A/Album X/02 Second Song.mp3', title: 'Second Song', artist_id: 1, artist_name: 'Artist A', album_id: 1, album_title: 'Album X', year: 2020, track_number: 2, duration_secs: 185, format: 'mp3', file_size: 8000000, collection_id: 1, collection_name: 'Music', liked: 1, youtube_url: null, added_at: 1700000000, modified_at: 1700000000 },
  { id: 3, path: 'file:///music/Artist B/Album Y/01 Third Song.mp3', title: 'Third Song', artist_id: 2, artist_name: 'Artist B', album_id: 2, album_title: 'Album Y', year: 2022, track_number: 1, duration_secs: 240, format: 'mp3', file_size: 10000000, collection_id: 1, collection_name: 'Music', liked: 0, youtube_url: null, added_at: 1700000000, modified_at: 1700000000 },
];

const TEST_ARTISTS = [
  { id: 1, name: 'Artist A', track_count: 2, liked: 0 },
  { id: 2, name: 'Artist B', track_count: 1, liked: 0 },
];

const TEST_ALBUMS = [
  { id: 1, title: 'Album X', artist_id: 1, artist_name: 'Artist A', year: 2020, track_count: 2, liked: 0 },
  { id: 2, title: 'Album Y', artist_id: 2, artist_name: 'Artist B', year: 2022, track_count: 1, liked: 0 },
];

const TEST_COLLECTIONS = [
  { id: 1, kind: 'local', name: 'Music', path: '/music', url: null, username: null, last_synced_at: null, auto_update: false, auto_update_interval_mins: 60, enabled: true, last_sync_duration_secs: null, last_sync_error: null },
];

// Mock invoke — returns sensible defaults for commands the app calls on startup
window.__TAURI_INTERNALS__.invoke = async function (cmd, args) {
  // Plugin commands (store, shortcuts, etc.) — return safe defaults
  if (cmd.startsWith('plugin:')) {
    // plugin:store — LazyStore operations
    if (cmd === 'plugin:store|get') return null;
    if (cmd === 'plugin:store|set') return null;
    if (cmd === 'plugin:store|load') return null;
    if (cmd === 'plugin:store|save') return null;
    if (cmd === 'plugin:store|clear') return null;
    if (cmd === 'plugin:store|keys') return [];
    if (cmd === 'plugin:store|values') return [];
    if (cmd === 'plugin:store|entries') return [];
    if (cmd === 'plugin:store|length') return 0;
    if (cmd === 'plugin:store|has') return false;

    // plugin:event — event system
    if (cmd === 'plugin:event|listen') {
      const handler = args.handler;
      if (!eventListeners.has(args.event)) {
        eventListeners.set(args.event, []);
      }
      eventListeners.get(args.event).push(handler);
      return handler;
    }
    if (cmd === 'plugin:event|emit') return null;
    if (cmd === 'plugin:event|unlisten') return null;

    // plugin:global-shortcut
    if (cmd.startsWith('plugin:global-shortcut')) return null;

    // plugin:deep-link
    if (cmd.startsWith('plugin:deep-link')) return null;

    // plugin:updater
    if (cmd.startsWith('plugin:updater')) return null;

    // plugin:window
    if (cmd.startsWith('plugin:window')) return null;

    // plugin:webview
    if (cmd.startsWith('plugin:webview')) return null;

    return null;
  }

  // App commands — return empty/default data so the UI renders
  switch (cmd) {
    case 'get_profile_info':
      return { storePath: 'mock-store.json' };
    case 'get_artists':
      return TEST_ARTISTS;
    case 'get_albums':
      return TEST_ALBUMS;
    case 'get_collections':
      return TEST_COLLECTIONS;
    case 'get_collection_stats':
      return [{ collection_id: 1, track_count: 3, video_count: 0, total_size: 48000000, total_duration: 635 }];
    case 'get_tags':
      return [];
    case 'get_track_count':
      return TEST_TRACKS.length;
    case 'get_album_count':
      return TEST_ALBUMS.length;
    case 'get_tracks':
      return TEST_TRACKS;
    case 'get_tracks_by_paths':
      return TEST_TRACKS.filter(t => (args.paths || []).includes(t.path));
    case 'get_tracks_by_tag':
      return [];
    case 'get_tracks_by_artist':
      return [];
    case 'get_liked_tracks':
      return [];
    case 'get_history_recent':
      return [];
    case 'get_history_most_played':
      return [];
    case 'get_history_most_played_since':
      return [];
    case 'get_history_artist_stats':
      return [];
    case 'get_cached_waveform':
      return null;
    case 'get_search_providers':
      return null;
    case 'write_frontend_log':
      return null;
    case 'get_startup_timing':
      return [];
    case 'plugin_list_installed':
      return [];
    case 'lastfm_set_session':
      return null;
    case 'lastfm_start_auto_import':
      return null;
    case 'lastfm_stop_auto_import':
      return null;
    case 'open_devtools':
      return null;
    case 'tidal_check_status':
      return null;
    default:
      console.warn('[tauri-mock] unhandled invoke:', cmd, args);
      return null;
  }
};
