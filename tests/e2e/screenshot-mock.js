// Extended Tauri IPC mock with rich data for website screenshots.
// Follows the same structure as tauri-mock.js but with realistic music data.

window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
window.__TAURI_EVENT_PLUGIN_INTERNALS__ =
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};

window.__TAURI_INTERNALS__.metadata = {
  currentWindow: { label: 'main' },
  currentWebview: { windowLabel: 'main', label: 'main' },
};

const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

// Real album cover art URLs from Apple Music / iTunes CDN
const ALBUM_COVER_URLS = {
  1:  'https://is1-ssl.mzstatic.com/image/thumb/Music116/v4/07/60/ba/0760ba0f-148c-b18f-d0ff-169ee96f3af5/634904078164.png/500x500bb.jpg', // OK Computer
  2:  'https://is1-ssl.mzstatic.com/image/thumb/Features125/v4/b5/4c/c2/b54cc20d-03f5-f2c4-4a0d-9b51ad65af89/dj.txuslqgv.jpg/500x500bb.jpg', // MHTRTC
  3:  'https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/c1/71/93/c1719342-df7d-e9c5-c87c-53dae5afb289/00042282855329.rgb.jpg/500x500bb.jpg', // Dummy
  4:  'https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/0a/98/55/0a98555b-8d9d-3b46-660a-b91261557d17/00724384559953.rgb.jpg/500x500bb.jpg', // Mezzanine
  5:  'https://is1-ssl.mzstatic.com/image/thumb/Music/80/01/7e/mzi.jmcslmlj.jpg/500x500bb.jpg', // Homogenic
  6:  'https://is1-ssl.mzstatic.com/image/thumb/Music116/v4/5f/b3/e0/5fb3e08d-c2cd-3da4-6ad7-c5dc61803683/cover.jpg/500x500bb.jpg', // SAW 85-92
  7:  'https://is1-ssl.mzstatic.com/image/thumb/Music114/v4/f7/34/fd/f734fd6c-aeca-8052-825c-706d1c665a8b/190296941856.jpg/500x500bb.jpg', // Ágætis byrjun
  8:  'https://is1-ssl.mzstatic.com/image/thumb/Music116/v4/76/cd/61/76cd61e7-0714-dce5-c48e-0f05f8fcb84b/652637001280.png/500x500bb.jpg', // Heaven or Las Vegas
  9:  'https://is1-ssl.mzstatic.com/image/thumb/Music114/v4/36/84/e8/3684e84e-5b87-f5d3-3e93-500c9807aefd/724385712951.jpg/500x500bb.jpg', // Spirit of Eden
  10: 'https://is1-ssl.mzstatic.com/image/thumb/Music116/v4/37/6e/f8/376ef839-8faf-242d-5a7c-8449d4fcf14c/652637270846.png/500x500bb.jpg', // Within the Realm
  11: 'https://is1-ssl.mzstatic.com/image/thumb/Music124/v4/1b/50/ad/1b50adc8-139b-1ad9-8500-cc2eb93faf17/888880730831.jpg/500x500bb.jpg', // Souvlaki
  12: 'https://is1-ssl.mzstatic.com/image/thumb/Music211/v4/f9/7e/6b/f97e6b94-f307-ae7f-e94c-d74860a44350/887830016094.png/500x500bb.jpg', // Loveless
  13: 'https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/ee/71/42/ee71425d-6bc9-3df8-c90b-8539f59144ab/00724386649553.rgb.jpg/500x500bb.jpg', // Music for Airports
  14: 'https://is1-ssl.mzstatic.com/image/thumb/Music/7f/9f/d6/mzi.vtnaewef.jpg/500x500bb.jpg', // Kind of Blue
  15: 'https://is1-ssl.mzstatic.com/image/thumb/Music114/v4/e5/24/aa/e524aacd-467b-66f3-8931-0fcd6750a4b9/08UMGIM07914.rgb.jpg/500x500bb.jpg', // A Love Supreme
  16: 'https://is1-ssl.mzstatic.com/image/thumb/Music122/v4/bd/8e/13/bd8e1358-b367-a689-cb84-cebd0b067dc4/634904078263.png/500x500bb.jpg', // Kid A
  17: 'https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/dd/50/c7/dd50c790-99ac-d3d0-5ab8-e3891fb8fd52/634904032463.png/500x500bb.jpg', // In Rainbows
  18: 'https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/2e/77/7c/2e777c13-60e3-c231-8be0-b0d43dc91598/mzi.yseuvnlj.jpg/500x500bb.jpg', // Geogaddi
  19: 'https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/e5/f7/c0/e5f7c07d-2182-e732-8ad6-be03814fe93c/13UABIM04453.rgb.jpg/500x500bb.jpg', // Blue Lines
  20: 'https://is1-ssl.mzstatic.com/image/thumb/Music116/v4/32/d6/28/32d62861-0e24-2111-d3ed-3b54f23083d5/081227607265.jpg/500x500bb.jpg', // Vespertine
  21: 'https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/18/db/05/18db0507-f276-d93d-a4a7-e856a3f1590a/13UAAIM08283.rgb.jpg/500x500bb.jpg', // I Put a Spell on You
};

// Map artist ID → first album ID (use album art as artist image)
const ARTIST_ALBUM_MAP = {
  1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8,
  9: 9, 10: 10, 11: 11, 12: 12, 13: 13, 14: 14, 15: 15, 16: 21,
};

// Map of mock image paths to real cover art URLs
const mockImageMap = {};

window.__TAURI_INTERNALS__.convertFileSrc = function (filePath, _protocol) {
  // If this is a mock image path, return the real cover art URL
  if (filePath && filePath.startsWith('/mock/images/')) {
    return mockImageMap[filePath] || SILENT_WAV;
  }
  return SILENT_WAV;
};

const callbacks = new Map();
window.__TAURI_INTERNALS__.transformCallback = function (callback, once) {
  const id = Math.floor(Math.random() * 0xffffffff);
  callbacks.set(id, function (data) {
    if (once) callbacks.delete(id);
    return callback && callback(data);
  });
  return id;
};
window.__TAURI_INTERNALS__.unregisterCallback = function (id) { callbacks.delete(id); };
window.__TAURI_INTERNALS__.runCallback = function (id, data) { const cb = callbacks.get(id); if (cb) cb(data); };
window.__TAURI_INTERNALS__.callbacks = callbacks;

const eventListeners = new Map();
window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function (event, id) { callbacks.delete(id); };

// ── Mock Data ──────────────────────────────────────────────

const ARTISTS = [
  { id: 1, name: 'Radiohead', track_count: 12, liked: 1 },
  { id: 2, name: 'Boards of Canada', track_count: 8, liked: 0 },
  { id: 3, name: 'Portishead', track_count: 6, liked: 1 },
  { id: 4, name: 'Massive Attack', track_count: 9, liked: 0 },
  { id: 5, name: 'Björk', track_count: 7, liked: 1 },
  { id: 6, name: 'Aphex Twin', track_count: 10, liked: 0 },
  { id: 7, name: 'Sigur Rós', track_count: 5, liked: 1 },
  { id: 8, name: 'Cocteau Twins', track_count: 6, liked: 0 },
  { id: 9, name: 'Talk Talk', track_count: 4, liked: 0 },
  { id: 10, name: 'Dead Can Dance', track_count: 5, liked: 1 },
  { id: 11, name: 'Slowdive', track_count: 7, liked: 0 },
  { id: 12, name: 'My Bloody Valentine', track_count: 5, liked: 1 },
  { id: 13, name: 'Brian Eno', track_count: 8, liked: 0 },
  { id: 14, name: 'Miles Davis', track_count: 9, liked: 1 },
  { id: 15, name: 'John Coltrane', track_count: 6, liked: 0 },
  { id: 16, name: 'Nina Simone', track_count: 5, liked: 1 },
];

const ALBUMS = [
  { id: 1, title: 'OK Computer', artist_id: 1, artist_name: 'Radiohead', year: 1997, track_count: 8, liked: 1 },
  { id: 2, title: 'Music Has the Right to Children', artist_id: 2, artist_name: 'Boards of Canada', year: 1998, track_count: 3, liked: 0 },
  { id: 3, title: 'Dummy', artist_id: 3, artist_name: 'Portishead', year: 1994, track_count: 4, liked: 1 },
  { id: 4, title: 'Mezzanine', artist_id: 4, artist_name: 'Massive Attack', year: 1998, track_count: 4, liked: 1 },
  { id: 5, title: 'Homogenic', artist_id: 5, artist_name: 'Björk', year: 1997, track_count: 3, liked: 0 },
  { id: 6, title: 'Selected Ambient Works 85-92', artist_id: 6, artist_name: 'Aphex Twin', year: 1992, track_count: 3, liked: 0 },
  { id: 7, title: 'Ágætis byrjun', artist_id: 7, artist_name: 'Sigur Rós', year: 1999, track_count: 2, liked: 1 },
  { id: 8, title: 'Heaven or Las Vegas', artist_id: 8, artist_name: 'Cocteau Twins', year: 1990, track_count: 2, liked: 0 },
  { id: 9, title: 'Spirit of Eden', artist_id: 9, artist_name: 'Talk Talk', year: 1988, track_count: 2, liked: 0 },
  { id: 10, title: 'Within the Realm of a Dying Sun', artist_id: 10, artist_name: 'Dead Can Dance', year: 1987, track_count: 2, liked: 1 },
  { id: 11, title: 'Souvlaki', artist_id: 11, artist_name: 'Slowdive', year: 1993, track_count: 2, liked: 0 },
  { id: 12, title: 'Loveless', artist_id: 12, artist_name: 'My Bloody Valentine', year: 1991, track_count: 3, liked: 1 },
  { id: 13, title: 'Ambient 1: Music for Airports', artist_id: 13, artist_name: 'Brian Eno', year: 1978, track_count: 2, liked: 0 },
  { id: 14, title: 'Kind of Blue', artist_id: 14, artist_name: 'Miles Davis', year: 1959, track_count: 4, liked: 1 },
  { id: 15, title: 'A Love Supreme', artist_id: 15, artist_name: 'John Coltrane', year: 1965, track_count: 2, liked: 1 },
  { id: 16, title: 'Kid A', artist_id: 1, artist_name: 'Radiohead', year: 2000, track_count: 2, liked: 0 },
  { id: 17, title: 'In Rainbows', artist_id: 1, artist_name: 'Radiohead', year: 2007, track_count: 2, liked: 1 },
  { id: 18, title: 'Geogaddi', artist_id: 2, artist_name: 'Boards of Canada', year: 2002, track_count: 2, liked: 0 },
  { id: 19, title: 'Blue Lines', artist_id: 4, artist_name: 'Massive Attack', year: 1991, track_count: 2, liked: 0 },
  { id: 20, title: 'Vespertine', artist_id: 5, artist_name: 'Björk', year: 2001, track_count: 2, liked: 1 },
  { id: 21, title: 'I Put a Spell on You', artist_id: 16, artist_name: 'Nina Simone', year: 1965, track_count: 3, liked: 1 },
];

// Pre-populate mock image paths with real Cover Art Archive URLs
for (const a of ARTISTS) {
  const albumId = ARTIST_ALBUM_MAP[a.id];
  if (albumId && ALBUM_COVER_URLS[albumId]) {
    mockImageMap[`/mock/images/artist/${a.id}`] = ALBUM_COVER_URLS[albumId];
  }
}
for (const a of ALBUMS) {
  if (ALBUM_COVER_URLS[a.id]) {
    mockImageMap[`/mock/images/album/${a.id}`] = ALBUM_COVER_URLS[a.id];
  }
}

const TRACK_DATA = [
  // [collectionId, title, artistId, artistName, albumId, albumTitle, year, trackNum, durationSecs, format]
  // Radiohead - OK Computer
  [1, 'Airbag', 1, 'Radiohead', 1, 'OK Computer', 1997, 1, 282, 'flac'],
  [1, 'Paranoid Android', 1, 'Radiohead', 1, 'OK Computer', 1997, 2, 386, 'flac'],
  [1, 'Subterranean Homesick Alien', 1, 'Radiohead', 1, 'OK Computer', 1997, 3, 263, 'flac'],
  [1, 'Exit Music (For a Film)', 1, 'Radiohead', 1, 'OK Computer', 1997, 4, 258, 'flac'],
  [1, 'Let Down', 1, 'Radiohead', 1, 'OK Computer', 1997, 5, 298, 'flac'],
  [1, 'Karma Police', 1, 'Radiohead', 1, 'OK Computer', 1997, 6, 264, 'flac'],
  [1, 'Lucky', 1, 'Radiohead', 1, 'OK Computer', 1997, 10, 264, 'flac'],
  [1, 'No Surprises', 1, 'Radiohead', 1, 'OK Computer', 1997, 11, 229, 'flac'],
  // Boards of Canada - MHTRTC
  [1, 'Roygbiv', 2, 'Boards of Canada', 2, 'Music Has the Right to Children', 1998, 5, 142, 'flac'],
  [1, 'Turquoise Hexagon Sun', 2, 'Boards of Canada', 2, 'Music Has the Right to Children', 1998, 9, 331, 'flac'],
  [1, 'Aquarius', 2, 'Boards of Canada', 2, 'Music Has the Right to Children', 1998, 2, 90, 'flac'],
  // Portishead - Dummy
  [1, 'Mysterons', 3, 'Portishead', 3, 'Dummy', 1994, 1, 305, 'flac'],
  [1, 'Sour Times', 3, 'Portishead', 3, 'Dummy', 1994, 2, 249, 'flac'],
  [1, 'Wandering Star', 3, 'Portishead', 3, 'Dummy', 1994, 5, 291, 'flac'],
  [1, 'Glory Box', 3, 'Portishead', 3, 'Dummy', 1994, 11, 307, 'mp3'],
  // Massive Attack - Mezzanine
  [1, 'Angel', 4, 'Massive Attack', 4, 'Mezzanine', 1998, 1, 379, 'flac'],
  [1, 'Teardrop', 4, 'Massive Attack', 4, 'Mezzanine', 1998, 3, 327, 'flac'],
  [1, 'Inertia Creeps', 4, 'Massive Attack', 4, 'Mezzanine', 1998, 4, 358, 'mp3'],
  [1, 'Dissolved Girl', 4, 'Massive Attack', 4, 'Mezzanine', 1998, 5, 345, 'flac'],
  // Björk - Homogenic
  [1, 'Hunter', 5, 'Björk', 5, 'Homogenic', 1997, 1, 284, 'flac'],
  [1, 'Jöga', 5, 'Björk', 5, 'Homogenic', 1997, 2, 303, 'flac'],
  [1, 'Bachelorette', 5, 'Björk', 5, 'Homogenic', 1997, 4, 324, 'mp3'],
  // Aphex Twin - SAW 85-92
  [1, 'Xtal', 6, 'Aphex Twin', 6, 'Selected Ambient Works 85-92', 1992, 1, 288, 'flac'],
  [1, 'Tha', 6, 'Aphex Twin', 6, 'Selected Ambient Works 85-92', 1992, 2, 547, 'flac'],
  [1, 'Heliosphan', 6, 'Aphex Twin', 6, 'Selected Ambient Works 85-92', 1992, 5, 271, 'flac'],
  // Sigur Rós - Ágætis byrjun
  [1, 'Svefn-g-englar', 7, 'Sigur Rós', 7, 'Ágætis byrjun', 1999, 2, 610, 'flac'],
  [1, 'Starálfur', 7, 'Sigur Rós', 7, 'Ágætis byrjun', 1999, 8, 390, 'flac'],
  // Cocteau Twins - Heaven or Las Vegas
  [1, 'Cherry-Coloured Funk', 8, 'Cocteau Twins', 8, 'Heaven or Las Vegas', 1990, 1, 332, 'flac'],
  [1, 'Iceblink Luck', 8, 'Cocteau Twins', 8, 'Heaven or Las Vegas', 1990, 3, 218, 'flac'],
  // Talk Talk - Spirit of Eden
  [1, 'The Rainbow', 9, 'Talk Talk', 9, 'Spirit of Eden', 1988, 1, 565, 'flac'],
  [1, 'Eden', 9, 'Talk Talk', 9, 'Spirit of Eden', 1988, 3, 436, 'flac'],
  // Dead Can Dance
  [1, 'Anywhere Out of the World', 10, 'Dead Can Dance', 10, 'Within the Realm of a Dying Sun', 1987, 1, 365, 'flac'],
  [1, 'Dawn of the Iconoclast', 10, 'Dead Can Dance', 10, 'Within the Realm of a Dying Sun', 1987, 3, 290, 'flac'],
  // Slowdive - Souvlaki
  [1, 'Alison', 11, 'Slowdive', 11, 'Souvlaki', 1993, 1, 312, 'flac'],
  [1, 'When the Sun Hits', 11, 'Slowdive', 11, 'Souvlaki', 1993, 4, 284, 'flac'],
  // My Bloody Valentine - Loveless
  [1, 'Only Shallow', 12, 'My Bloody Valentine', 12, 'Loveless', 1991, 1, 258, 'flac'],
  [1, 'To Here Knows When', 12, 'My Bloody Valentine', 12, 'Loveless', 1991, 3, 327, 'flac'],
  [1, 'Sometimes', 12, 'My Bloody Valentine', 12, 'Loveless', 1991, 5, 315, 'flac'],
  // Brian Eno - Music for Airports
  [1, '1/1', 13, 'Brian Eno', 13, 'Ambient 1: Music for Airports', 1978, 1, 1033, 'flac'],
  [1, '2/1', 13, 'Brian Eno', 13, 'Ambient 1: Music for Airports', 1978, 2, 527, 'flac'],
  // Miles Davis - Kind of Blue (on Navidrome)
  [2, 'So What', 14, 'Miles Davis', 14, 'Kind of Blue', 1959, 1, 562, 'flac'],
  [2, 'Freddie Freeloader', 14, 'Miles Davis', 14, 'Kind of Blue', 1959, 2, 587, 'flac'],
  [2, 'Blue in Green', 14, 'Miles Davis', 14, 'Kind of Blue', 1959, 3, 327, 'flac'],
  [2, 'All Blues', 14, 'Miles Davis', 14, 'Kind of Blue', 1959, 4, 693, 'flac'],
  // John Coltrane (on Navidrome)
  [2, 'A Love Supreme, Pt. 1 — Acknowledgement', 15, 'John Coltrane', 15, 'A Love Supreme', 1965, 1, 468, 'flac'],
  [2, 'A Love Supreme, Pt. 2 — Resolution', 15, 'John Coltrane', 15, 'A Love Supreme', 1965, 2, 441, 'flac'],
  // Radiohead extras
  [1, 'Everything in Its Right Place', 1, 'Radiohead', 16, 'Kid A', 2000, 1, 252, 'flac'],
  [1, 'Idioteque', 1, 'Radiohead', 16, 'Kid A', 2000, 8, 309, 'flac'],
  [1, '15 Step', 1, 'Radiohead', 17, 'In Rainbows', 2007, 1, 237, 'flac'],
  [1, 'Reckoner', 1, 'Radiohead', 17, 'In Rainbows', 2007, 7, 290, 'flac'],
  // Nina Simone (on Navidrome)
  [2, 'Feeling Good', 16, 'Nina Simone', 21, 'I Put a Spell on You', 1965, 1, 177, 'mp3'],
  [2, 'I Put a Spell on You', 16, 'Nina Simone', 21, 'I Put a Spell on You', 1965, 2, 156, 'mp3'],
  [2, 'Sinnerman', 16, 'Nina Simone', 21, 'I Put a Spell on You', 1965, 3, 618, 'mp3'],
  // Extra BoC / Massive Attack
  [1, 'Music Is Math', 2, 'Boards of Canada', 18, 'Geogaddi', 2002, 2, 350, 'flac'],
  [1, '1969', 2, 'Boards of Canada', 18, 'Geogaddi', 2002, 3, 287, 'flac'],
  [1, 'Safe from Harm', 4, 'Massive Attack', 19, 'Blue Lines', 1991, 2, 307, 'flac'],
  [1, 'Unfinished Sympathy', 4, 'Massive Attack', 19, 'Blue Lines', 1991, 3, 311, 'flac'],
  // Björk - Vespertine
  [1, 'Hidden Place', 5, 'Björk', 20, 'Vespertine', 2001, 1, 332, 'flac'],
  [1, 'Pagan Poetry', 5, 'Björk', 20, 'Vespertine', 2001, 5, 323, 'flac'],
];

const TRACKS = TRACK_DATA.map(([collId, title, artistId, artistName, albumId, albumTitle, year, trackNum, dur, fmt], i) => ({
  id: i + 1,
  path: `/music/${artistName}/${albumTitle}/${String(trackNum).padStart(2, '0')} ${title}.${fmt}`,
  title,
  artist_id: artistId,
  artist_name: artistName,
  album_id: albumId,
  album_title: albumTitle,
  year,
  track_number: trackNum,
  duration_secs: dur,
  format: fmt,
  file_size: dur * 80000,
  collection_id: collId,
  collection_name: collId === 1 ? 'Local Music' : 'Navidrome',
  liked: (i % 5 === 0) ? 1 : 0,
  youtube_url: null,
  added_at: 1700000000 + i * 1000,
  modified_at: 1700000000 + i * 1000,
  relative_path: null,
}));

const TAGS = [
  { id: 1, name: 'Electronic', track_count: 14, liked: 0 },
  { id: 2, name: 'Trip Hop', track_count: 10, liked: 0 },
  { id: 3, name: 'Ambient', track_count: 9, liked: 0 },
  { id: 4, name: 'Post-Rock', track_count: 7, liked: 0 },
  { id: 5, name: 'Shoegaze', track_count: 8, liked: 0 },
  { id: 6, name: 'Jazz', track_count: 9, liked: 1 },
  { id: 7, name: 'Alternative Rock', track_count: 12, liked: 0 },
  { id: 8, name: 'Dream Pop', track_count: 6, liked: 0 },
  { id: 9, name: 'Art Rock', track_count: 5, liked: 0 },
  { id: 10, name: 'Downtempo', track_count: 4, liked: 0 },
];

const COLLECTIONS = [
  { id: 1, kind: 'local', name: 'Local Music', path: '/Users/alex/Music', url: null, username: null, last_synced_at: 1712800000, auto_update: true, auto_update_interval_mins: 60, enabled: true, last_sync_duration_secs: 2.3, last_sync_error: null },
  { id: 2, kind: 'subsonic', name: 'Navidrome', path: null, url: 'https://music.example.com', username: 'alex', last_synced_at: 1712790000, auto_update: true, auto_update_interval_mins: 120, enabled: true, last_sync_duration_secs: 8.1, last_sync_error: null },
];

const COLLECTION_STATS = [
  { collection_id: 1, track_count: 48, video_count: 0, total_size: 3200000000, total_duration: 14250 },
  { collection_id: 2, track_count: 11, video_count: 0, total_size: 980000000, total_duration: 4036 },
];

const now = Math.floor(Date.now() / 1000);

const HISTORY_RECENT = TRACKS.slice(0, 12).map((t, i) => ({
  id: i + 1,
  history_track_id: t.id,
  played_at: now - i * 3600,
  display_title: t.title,
  display_artist: t.artist_name,
  play_count: 5 + Math.floor(i * 1.5),
  library_track_id: t.id,
}));

const HISTORY_MOST_PLAYED = TRACKS.slice(0, 10).map((t, i) => ({
  history_track_id: t.id,
  play_count: 40 - i * 3,
  display_title: t.title,
  display_artist: t.artist_name,
  library_track_id: t.id,
  rank: i + 1,
}));

const HISTORY_MOST_PLAYED_ARTISTS = ARTISTS.slice(0, 8).map((a, i) => ({
  history_artist_id: a.id,
  play_count: 80 - i * 8,
  track_count: a.track_count,
  display_name: a.name,
  library_artist_id: a.id,
  rank: i + 1,
}));

const SEARCH_RESULTS = {
  artists: ARTISTS.slice(0, 2),
  albums: ALBUMS.slice(0, 2),
  tracks: TRACKS.slice(0, 3),
};

// ── Invoke Handler ──────────────────────────────────────────

window.__TAURI_INTERNALS__.invoke = async function (cmd, args) {
  if (cmd.startsWith('plugin:')) {
    if (cmd === 'plugin:store|get') {
      const key = args && args.key;
      if (key === 'sidebarCollapsed' || key === 'queueCollapsed') return [true, true];
      return [null, false];
    }
    if (cmd === 'plugin:store|get_store') return 1;
    if (cmd === 'plugin:store|set') return null;
    if (cmd === 'plugin:store|load') return null;
    if (cmd === 'plugin:store|save') return null;
    if (cmd === 'plugin:store|clear') return null;
    if (cmd === 'plugin:store|keys') return [];
    if (cmd === 'plugin:store|values') return [];
    if (cmd === 'plugin:store|entries') return [];
    if (cmd === 'plugin:store|length') return 0;
    if (cmd === 'plugin:store|has') return false;
    if (cmd === 'plugin:event|listen') {
      if (!eventListeners.has(args.event)) eventListeners.set(args.event, []);
      eventListeners.get(args.event).push(args.handler);
      return args.handler;
    }
    if (cmd === 'plugin:event|emit') return null;
    if (cmd === 'plugin:event|unlisten') return null;
    if (cmd.startsWith('plugin:global-shortcut')) return null;
    if (cmd.startsWith('plugin:deep-link')) return null;
    if (cmd.startsWith('plugin:updater')) return null;
    if (cmd.startsWith('plugin:window')) return null;
    if (cmd.startsWith('plugin:webview')) return null;
    return null;
  }

  switch (cmd) {
    case 'get_profile_info': return { storePath: 'mock-store.json' };
    case 'get_artists': return ARTISTS;
    case 'get_albums': return ALBUMS;
    case 'get_collections': return COLLECTIONS;
    case 'get_collection_stats': return COLLECTION_STATS;
    case 'get_tags': return TAGS;
    case 'get_track_count': return TRACKS.length;
    case 'get_tracks': return TRACKS;
    case 'get_tracks_by_paths': return TRACKS.filter(t => (args.paths || []).includes(t.path));
    case 'get_tracks_by_ids': return TRACKS.filter(t => (args.ids || []).includes(t.id));
    case 'get_tracks_by_tag': return TRACKS.slice(0, 8);
    case 'get_tracks_by_artist': {
      const aid = args.artistId;
      return TRACKS.filter(t => t.artist_id === aid);
    }
    case 'get_liked_tracks': return TRACKS.filter(t => t.liked === 1);
    case 'get_history_recent': return HISTORY_RECENT;
    case 'get_history_most_played': return HISTORY_MOST_PLAYED;
    case 'get_history_most_played_since': return HISTORY_MOST_PLAYED.slice(0, 7);
    case 'get_history_most_played_artists': return HISTORY_MOST_PLAYED_ARTISTS;
    case 'search_all': return SEARCH_RESULTS;
    case 'search_history_artists': return [];
    case 'search_history_tracks': return [];
    case 'list_user_skins': return [];
    case 'get_download_status': return [];
    case 'info_sync_types': return [];
    case 'sync_image_providers': return [];
    case 'write_frontend_log': return null;
    case 'get_cached_waveform': return null;
    case 'get_startup_timing': return [];
    case 'plugin_list_installed': return [];
    case 'tidal_check_status': return null;
    case 'get_tags_for_track': return [TAGS[0], TAGS[6]];
    case 'get_track_play_stats': return { play_count: 23, first_played: now - 86400 * 30, last_played: now - 3600 };
    case 'get_track_play_history': return HISTORY_RECENT.slice(0, 5);
    case 'get_track_audio_properties': return { sample_rate: 44100, bit_depth: 16, channels: 2, bitrate: 1411 };
    case 'get_auto_continue_track': return null;
    case 'get_entity_image': {
      const kind = args.kind;
      const id = args.id;
      const p = `/mock/images/${kind}/${id}`;
      return mockImageMap[p] ? p : null;
    }
    case 'get_entity_image_by_name': return null;
    case 'get_image_providers': return [];
    case 'get_track_by_id': return TRACKS.find(t => t.id === (args.id || args.trackId)) || null;
    case 'fetch_skin_gallery': return [];
    case 'fetch_plugin_gallery': return [];
    case 'info_get_types_for_entity': return [];
    case 'info_get_cached_values': return [];
    case 'info_get_values_for_entity': return [];
    case 'tidal_search': return { artists: [], albums: [], tracks: [] };
    case 'get_track_rank': return null;
    case 'get_artist_rank': return null;
    case 'fetch_artist_image': {
      // Emit artist-image-ready event after a short delay
      const aid = args.artistId;
      const p = `/mock/images/artist/${aid}`;
      if (mockImageMap[p]) {
        setTimeout(() => {
          const handlers = eventListeners.get('artist-image-ready') || [];
          for (const hid of handlers) {
            const cb = callbacks.get(hid);
            if (cb) cb({ event: 'artist-image-ready', payload: { artistId: aid, path: p, name: args.artistName, source: 'mock' } });
          }
        }, 50);
      }
      return null;
    }
    case 'fetch_album_image': {
      const aid = args.albumId;
      const p = `/mock/images/album/${aid}`;
      if (mockImageMap[p]) {
        setTimeout(() => {
          const handlers = eventListeners.get('album-image-ready') || [];
          for (const hid of handlers) {
            const cb = callbacks.get(hid);
            if (cb) cb({ event: 'album-image-ready', payload: { albumId: aid, path: p, title: args.albumTitle, source: 'mock' } });
          }
        }, 50);
      }
      return null;
    }
    case 'fetch_tag_image': return null;
    case 'record_play': return null;
    case 'toggle_liked': return null;
    default:
      console.warn('[screenshot-mock] unhandled invoke:', cmd, args);
      return null;
  }
};
