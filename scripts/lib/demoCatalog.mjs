// The demo library the website is captured from (`npm run demo:library`,
// `npm run demo:setup`, then `npm run capture:media -- --demo <dir>`).
//
// It exists because the site's screenshots and videos used to be captured
// from a real profile, which published the owner's whole collection, history
// and likes. The library is a set of well-known albums (demoAlbumPicks.mjs,
// tracklists in demoAlbums.mjs from MusicBrainz) whose *audio is synthesised*;
// covers, artist photos and bios come from the app's own providers, exactly
// as for a user's library. History and likes are invented.
//
// One album is fiction on purpose: Glass Harbour's "Tidewater Hymns" carries
// the only lyrics on the site (original, as sidecar .lrc) and its own
// procedural folder art (`demoArt.mjs`). Real songs' lyrics are copyrighted,
// so the lyrics scenes use it and setup switches the online lyrics
// providers off.
//
// Pure data + pure planning functions; the generator does the I/O. Pinned by
// `src/__tests__/demoCatalog.test.ts`.

import { hashString, rng } from "./demoArt.mjs";
import { DEMO_ALBUMS } from "./demoAlbums.mjs";

/** The invented album: it carries the lyrics and procedural art (`art`). */
const FICTION = [
  {
    artist: "Glass Harbour", title: "Tidewater Hymns", year: 2019, tags: ["Dream Pop"], mood: "major", bpm: 84, art: true,
    tracks: ["Paper Lanterns", "Saltglass", "Undertow Choir", "Harbour Lights", "The Long Low Tide", "Foghorn Lullaby", "Sea Wall", "Blue Hour Ferry", "Driftwood Crown", "Tidewater"]
      .map((title) => ({ title, durationSecs: null })),
  },
];

/** A compilation tagged the way a careless rip is: one album title, a
 *  different ARTIST per track and **no ALBUMARTIST** — so the app files it as
 *  one album per performer. It is what the collectors' "fix a hundred tracks
 *  at once" short repairs on camera (Bulk Edit → Album artist), and the shorts
 *  runner regenerates it before each take (`make-demo-library` rewrites the
 *  tags, ALBUMARTIST removed). Its tracks are real songs from the albums above
 *  (names only, like the rest), with their real lengths; the title is
 *  invented, so its cover is procedural folder art, shared by every fork —
 *  which is what makes the split read as one album broken apart. */
const COMPILATION_TRACKS = [
  ["Massive Attack", "Teardrop"], ["Radiohead", "Let Down"], ["Daft Punk", "Instant Crush"],
  // Not the showcase's detail/radio track ("Dreams"): a by-name lookup for
  // that one must land on the Rumours copy.
  ["Tame Impala", "Let It Happen"], ["Fleetwood Mac", "Go Your Own Way"], ["SZA", "Kill Bill"],
  ["The Strokes", "Someday"], ["Dua Lipa", "Levitating"], ["Alvvays", "Pharmacist"],
  ["Pink Floyd", "Time"], ["Arcade Fire", "Crown of Love"], ["U2", "With or Without You"],
];

function songLength(artist, title) {
  for (const album of DEMO_ALBUMS) {
    if (album.artist !== artist) continue;
    const track = album.tracks.find((t) => t.title === title);
    if (track) return track.durationSecs;
  }
  throw new Error(`compilation track not in the catalogue: ${artist} — ${title}`);
}

const COMPILATIONS = [
  {
    artist: "Various Artists", title: "Late Night Drive", year: 2024, tags: ["Pop"], mood: "minor", bpm: 96,
    art: true, compilation: true,
    tracks: COMPILATION_TRACKS.map(([artist, title]) => ({ artist, title, durationSecs: songLength(artist, title) })),
  },
];

/** Every album of the library: `{ artist, title, year, tags, mood, bpm,
 *  format?, art?, compilation?, tracks: [{ title, durationSecs, artist? }] }`.
 *  A compilation's `artist` is only its folder; each track names its own. */
export const ALBUMS = [...DEMO_ALBUMS, ...FICTION, ...COMPILATIONS];

/** Artist names, in album order (compilations have no artist of their own). */
export const ARTISTS = [...new Set(ALBUMS.filter((a) => !a.compilation).map((a) => a.artist))];

/** Original lyrics, written for this library. Timestamps in seconds. The
 *  capture's lyrics scene seeks to ~50s, so the middle lines carry the shot. */
export const LYRICS = [
  {
    artist: "Glass Harbour", title: "Paper Lanterns",
    lines: [
      [12, "We folded the evening into paper"], [17, "and set it on the water, burning slow"],
      [23, "every little light a question"], [28, "drifting where the cold currents go"],
      [35, "Paper lanterns, carry what we couldn't say"], [41, "out past the harbour wall and far away"],
      [47, "Paper lanterns, ten thousand tiny suns"], [53, "lighting up the dark for everyone"],
      [61, "Your hand was warm against the railing"], [66, "the ferry horn was singing in the haze"],
      [72, "we counted every light that made it"], [77, "and lost count somewhere in the waves"],
      [84, "Paper lanterns, carry what we couldn't say"], [90, "out past the harbour wall and far away"],
      [96, "Paper lanterns, ten thousand tiny suns"], [102, "lighting up the dark for everyone"],
      [112, "And if the wind should take them under"], [118, "the water keeps a little of the glow"],
      [124, "so every tide that turns tomorrow"], [130, "will bring a little of tonight back home"],
    ],
  },
];

/** Cue sheets the demo profile carries (PUT /v1/cues), for the website's cue
 *  card shot. Only the invented album gets one: a cue sheet is notes about a
 *  real song's meaning and story, and on a public page those would be facts
 *  about real people that nobody checked. Text cues only — an image cue needs
 *  a real, credited URL, which an invented band doesn't have. Timed to the
 *  LYRICS above; the capture's grab lands at ~50s, inside the "tiny suns" cue. */
export const CUE_SHEETS = [
  {
    artist: "Glass Harbour", title: "Paper Lanterns",
    sheet: {
      mode: "cards",
      cues: [
        { at: 3, kind: "text", label: "The song", text: "The opening track of Tidewater Hymns, written the week after a lantern festival on the band's home harbour." },
        { at: 12, kind: "quote", label: "Meaning", text: "We folded the evening into paper", caption: "The whole song in one image: a long day made small enough to let go of." },
        { at: 28, kind: "text", label: "Recording", text: "The swell under this line is a field recording, taped from the sea wall at dusk." },
        { at: 35, kind: "quote", label: "Meaning", text: "Paper lanterns, carry what we couldn't say", caption: "Each lantern stands in for something left unsaid. The chorus hands them all to the tide." },
        { at: 47, kind: "quote", label: "Meaning", text: "Paper lanterns, ten thousand tiny suns", caption: "From the sea wall the lanterns blur into one band of light. Here every small thing adds up." },
        { at: 61, kind: "quote", label: "Meaning", text: "Your hand was warm against the railing", caption: "The second verse turns personal: the festival is also the night two people met." },
        { at: 72, kind: "text", label: "Trivia", text: "The ferry horn is real too, played back at half speed so it sits in the song's key." },
        { at: 112, kind: "quote", label: "Meaning", text: "the water keeps a little of the glow", caption: "Nothing set adrift is lost entirely. The last verse is the song's answer to its first line." },
      ],
    },
  },
];

/** Which demo track each capture scene leans on, so `capture-site-media
 *  --demo` doesn't have to guess (the generator writes these into the
 *  manifest). */
export const SHOWCASE = {
  heroArtist: "Radiohead",
  lyrics: { artist: "Glass Harbour", title: "Paper Lanterns" },
  radioSeed: { artist: "Fleetwood Mac", title: "Dreams" },
  detailAlbum: { artist: "Radiohead", title: "OK Computer" },
  detailTrack: { artist: "Fleetwood Mac", title: "Dreams" },
  // A FLAC for the "lossless" shot, from a genre the radio seed never reaches
  // (its station is Rock): a track already in the queue confuses the
  // capture's play-it-then-undo step.
  lossless: { artist: "Miles Davis", title: "So What" },
  // The mis-tagged compilation the collectors' short fixes (see COMPILATIONS).
  compilation: { title: "Late Night Drive", albumArtist: "Various Artists" },
  searchQuery: "love",
  // History: a recent obsession, and favourites not played for months.
  obsession: "Random Access Memories",
  forgotten: ["Kind of Blue", "Pet Sounds"],
};

const safe = (s) => s.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+$/, "");

/** Every track of the catalogue, flattened, with its on-disk location. Real
 *  albums keep their real durations; the invented one gets deterministic ones
 *  (long enough, for a song with lyrics, to hold every line). */
export function catalogTracks() {
  const out = [];
  for (const album of ALBUMS) {
    album.tracks.forEach((track, i) => {
      const r = rng(`${album.artist}|${album.title}|${track.title}`);
      const ext = album.format === "flac" ? "flac" : "mp3";
      const artist = track.artist ?? album.artist;
      const lyrics = LYRICS.find((l) => l.artist === artist && l.title === track.title) ?? null;
      out.push({
        artist, album: album.title, year: album.year, title: track.title,
        // ALBUMARTIST to write; null = none (a compilation's messy state).
        albumArtist: album.compilation ? null : album.artist,
        trackNumber: i + 1, trackTotal: album.tracks.length, tags: album.tags,
        mood: album.mood, bpm: album.bpm, format: ext, art: Boolean(album.art),
        durationSecs: track.durationSecs ?? (lyrics ? 168 + Math.round(r() * 40) : 150 + Math.round(r() * 170)),
        dir: `${safe(album.artist)}/${album.year} - ${safe(album.title)}`,
        file: `${String(i + 1).padStart(2, "0")} - ${safe(track.title)}.${ext}`,
        lyrics,
      });
    });
  }
  return out;
}

/** LRC text for one lyrics entry. */
export function lrcText(entry) {
  const ts = (s) => `[${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.00]`;
  return [`[ar:${entry.artist}]`, `[ti:${entry.title}]`, ...entry.lines.map(([s, line]) => `${ts(s)}${line}`)].join("\n") + "\n";
}

const MAJOR = [0, 7, 9, 5]; // I V vi IV
const MINOR = [0, 8, 3, 10]; // i VI III VII

/**
 * An ffmpeg `aevalsrc` expression for one synthesised track: a chord pad over
 * a four-chord loop, a bass line, a kick on every beat and a noise hat on the
 * off-beat, all under a slow section swell — enough shape that the waveform
 * seek bar looks like music rather than a flat line. Deterministic per track.
 */
export function synthExpression(track) {
  const r = rng(`synth|${track.artist}|${track.title}`);
  const root = 110 * Math.pow(2, Math.floor(r() * 12) / 12); // A2..G#3
  const prog = track.mood === "minor" ? MINOR : MAJOR;
  const third = track.mood === "minor" ? 1.1892 : 1.2599;
  const beat = 60 / track.bpm;
  const bar = beat * 4;
  // Chord index → root multiplier, chosen per two bars.
  const c = `mod(floor(t/${(bar * 2).toFixed(4)}),4)`;
  const mult = prog.map((s) => Math.pow(2, s / 12).toFixed(5));
  const R = `${root.toFixed(3)}*if(eq(${c},0),${mult[0]},if(eq(${c},1),${mult[1]},if(eq(${c},2),${mult[2]},${mult[3]})))`;
  const ph = `mod(t,${beat.toFixed(4)})`;
  // Verse / chorus: eight-bar sections, the second half of every 32 bars
  // louder, plus a slow swell — the step changes are what make the waveform
  // seek bar read as a song.
  const section = `(0.4+0.6*gte(mod(floor(t/${(bar * 8).toFixed(4)}),4),2))`;
  const swell = `${section}*(0.8+0.2*sin(PI*t/${(track.durationSecs / (2 + Math.floor(r() * 3))).toFixed(2)}))`;
  const pad = `0.10*(sin(2*PI*${R}*t)+0.8*sin(2*PI*${R}*${third}*t)+0.7*sin(2*PI*${R}*1.4983*t)+0.3*sin(2*PI*${R}*2.003*t))`;
  const bass = `0.22*sin(2*PI*${R}*0.5*t)*(0.6+0.4*exp(-${ph}*6))`;
  const kick = `0.45*exp(-${ph}*14)*sin(2*PI*(42+90*exp(-${ph}*40))*${ph})`;
  const hat = `0.05*(random(0)*2-1)*exp(-mod(t+${(beat / 2).toFixed(4)},${beat.toFixed(4)})*55)`;
  return `2.2*((${pad}+${bass}+${kick})*${swell}+${hat})`;
}

const DAY = 86400;

/**
 * A believable listening history for the Home shelves: a few favourite
 * artists dominating, a recent obsession (the last fortnight), and a set of
 * "forgotten favourites" played heavily months ago and not since. Returns
 * `[{ artist, title, playedAt }]` (unix seconds), deterministic for a given
 * `now`.
 */
export function historyPlan(tracks, now) {
  const r = rng("history");
  const byArtist = new Map();
  for (const t of tracks) {
    if (!byArtist.has(t.artist)) byArtist.set(t.artist, []);
    byArtist.get(t.artist).push(t);
  }
  const artists = [...byArtist.keys()];
  // A skewed artist weight: some artists are simply played more.
  const weight = new Map(artists.map((a) => [a, 0.2 + Math.pow(rng(`w|${a}`)(), 2) * 3]));
  weight.set(SHOWCASE.heroArtist, 4);
  const total = [...weight.values()].reduce((a, b) => a + b, 0);
  const pickArtist = () => {
    let x = r() * total;
    for (const [a, w] of weight) { x -= w; if (x <= 0) return a; }
    return artists[0];
  };
  const plays = [];
  const add = (t, daysAgo) => plays.push({ artist: t.artist, title: t.title, playedAt: Math.round(now - daysAgo * DAY - r() * 3600 * 10) });
  // Background listening over ~200 days.
  for (let i = 0; i < 1400; i++) {
    const list = byArtist.get(pickArtist());
    add(list[Math.floor(Math.pow(r(), 1.6) * list.length)], r() * 200);
  }
  // Recent obsession: one album on repeat over the last two weeks.
  const obsession = tracks.filter((t) => t.album === SHOWCASE.obsession);
  for (let i = 0; i < 120; i++) add(obsession[Math.floor(r() * obsession.length)], r() * 14);
  // Forgotten favourites: heavy plays 150–220 days ago, nothing since.
  const forgotten = tracks.filter((t) => SHOWCASE.forgotten.includes(t.album));
  for (const t of forgotten) for (let i = 0; i < 6 + Math.floor(r() * 8); i++) add(t, 150 + r() * 70);
  const forgottenKeys = new Set(forgotten.map((t) => `${t.artist}|${t.title}`));
  return plays
    .filter((p) => !forgottenKeys.has(`${p.artist}|${p.title}`) || p.playedAt < now - 150 * DAY)
    .sort((a, b) => a.playedAt - b.playedAt);
}

/** Tracks / albums / artists the demo profile marks as liked. */
export function likePlan(tracks) {
  const liked = tracks.filter((t) => (hashString(`${t.artist}|${t.title}`) % 7 === 0) || t.title === SHOWCASE.lyrics.title);
  return {
    tracks: liked.map((t) => ({ title: t.title, artistName: t.artist, albumTitle: t.album })),
    albums: [
      { title: "OK Computer", artistName: "Radiohead" },
      { title: "Rumours", artistName: "Fleetwood Mac" },
      { title: "Abbey Road", artistName: "The Beatles" },
      { title: "Currents", artistName: "Tame Impala" },
      { title: "Random Access Memories", artistName: "Daft Punk" },
    ],
    artists: ["Radiohead", "Fleetwood Mac", "Daft Punk"],
  };
}

/** The history tables' key for a name: lowercased, diacritics stripped —
 *  `strip_diacritics(to_lowercase())` in the app (NFD, combining marks
 *  dropped), or a play would never match its track. */
export const canonicalName = (s) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

/** SQL that writes `plays` into the history tables (keys via
 *  `canonicalName`, as `record_history_plays_batch` does) and spreads the albums' `added_at` over the
 *  last year so "Recently added" has an order. Run with the app stopped. */
export function historySql(plays, tracks, now) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const artists = new Map();
  const songs = new Map();
  for (const p of plays) {
    const a = artists.get(p.artist) ?? { first: p.playedAt, last: p.playedAt, count: 0 };
    a.first = Math.min(a.first, p.playedAt); a.last = Math.max(a.last, p.playedAt); a.count++;
    artists.set(p.artist, a);
    const key = `${p.artist}|${p.title}`;
    const s = songs.get(key) ?? { artist: p.artist, title: p.title, first: p.playedAt, last: p.playedAt, count: 0, plays: [] };
    s.first = Math.min(s.first, p.playedAt); s.last = Math.max(s.last, p.playedAt); s.count++; s.plays.push(p.playedAt);
    songs.set(key, s);
  }
  const lines = ["BEGIN;", "DELETE FROM history_plays;", "DELETE FROM history_tracks;", "DELETE FROM history_artists;"];
  for (const [name, a] of artists) {
    lines.push(`INSERT INTO history_artists (canonical_name, display_name, first_played_at, last_played_at, play_count) VALUES (${q(canonicalName(name))}, ${q(name)}, ${a.first}, ${a.last}, ${a.count});`);
  }
  for (const s of songs.values()) {
    const artistId = `(SELECT id FROM history_artists WHERE canonical_name = ${q(canonicalName(s.artist))})`;
    lines.push(`INSERT INTO history_tracks (history_artist_id, canonical_title, display_title, first_played_at, last_played_at, play_count) VALUES (${artistId}, ${q(canonicalName(s.title))}, ${q(s.title)}, ${s.first}, ${s.last}, ${s.count});`);
    const trackId = `(SELECT id FROM history_tracks WHERE history_artist_id = ${artistId} AND canonical_title = ${q(canonicalName(s.title))})`;
    for (const at of s.plays) lines.push(`INSERT INTO history_plays (history_track_id, played_at) VALUES (${trackId}, ${at});`);
  }
  const albums = [...new Set(tracks.map((t) => t.album))];
  albums.forEach((album, i) => {
    const addedAt = Math.round(now - (i / albums.length) * 365 * DAY);
    lines.push(`UPDATE tracks SET added_at = ${addedAt} WHERE album_id IN (SELECT id FROM albums WHERE title = ${q(album)});`);
  });
  lines.push("COMMIT;");
  return lines.join("\n") + "\n";
}
