// The demo library the website is captured from (`npm run demo:library`,
// `npm run demo:setup`, then `npm run capture:media -- --demo <dir>`).
//
// It exists because the site's screenshots and videos used to be captured
// from a real profile, which published the owner's whole collection — album
// art, listening history, likes — to anyone visiting the site. Everything
// here is invented: the artists, albums, titles and lyrics are fiction, the
// covers are procedural (`demoArt.mjs`) and the audio is synthesised.
//
// Names were chosen to be unlikely to match a real act, because the online
// image/info providers look artists up by name. Folder art (`cover.png`,
// `artist.png`) is probed before any network provider, so even a collision
// can't put a real band's photo on an album here — but a bio could still
// appear, so review the captures as usual.
//
// Pure data + pure planning functions; the generator does the I/O. Pinned by
// `src/__tests__/demoCatalog.test.ts`.

import { hashString, rng } from "./demoArt.mjs";

/** `mood` picks the scale of the synthesised music; `bpm` its tempo. The
 *  first tag is the one written to the files (the scanner keeps one genre per
 *  track), and it is a shared family on purpose: radio fills a station from
 *  other artists carrying the seed artist's tags, so a genre no one else has
 *  makes a one-artist station. */
export const ARTISTS = [
  {
    name: "Glass Harbour", tags: ["Dream Pop", "Shoegaze"], mood: "major", bpm: 84,
    albums: [
      { title: "Tidewater Hymns", year: 2019, tracks: ["Paper Lanterns", "Saltglass", "Undertow Choir", "Harbour Lights", "The Long Low Tide", "Foghorn Lullaby", "Sea Wall", "Blue Hour Ferry", "Driftwood Crown", "Tidewater"] },
      { title: "Lowlight Atlas", year: 2022, tracks: ["Lowlight", "Atlas of Small Hours", "Halogen", "Glasshouse Summer", "Weathervane", "Under the Pier", "Static on the Water", "Moon Ledger", "Lantern Keeper"] },
    ],
  },
  {
    name: "The Paper Moths", tags: ["Indie Rock", "Post-Punk"], mood: "minor", bpm: 132,
    albums: [
      { title: "Static Bloom", year: 2017, tracks: ["Static Bloom", "Fluorescent Saints", "Corner Shop Prophets", "Rust Belt Valentine", "Sodium Light", "Hymn for a Fire Escape", "Paper Cuts", "Moth to the Neon", "Overpass", "Disconnect Tone", "Last Train Out"] },
      { title: "Night Bus Gospel", year: 2021, tracks: ["Night Bus Gospel", "Concrete Choir", "Ticket Stub", "Satellite Town", "Wire & Glass", "Dial Tone Romance", "Exit Wounds of the Weekend", "Northbound", "Kerosene Kids", "Morning Shift"] },
    ],
  },
  {
    name: "Marlo Vance & the Weather", tags: ["Folk", "Alt-Country"], mood: "major", bpm: 96,
    albums: [
      { title: "Dust on the Dial", year: 2015, tracks: ["Dust on the Dial", "Two Coyotes", "Barn Owl Waltz", "Mile Marker 9", "Rain on a Tin Roof", "Gasoline Hymnal", "Prairie Static", "Weathered", "Late Harvest", "Porch Light Song"] },
    ],
  },
  {
    name: "Kiln Theory", tags: ["Ambient", "Post-Rock"], mood: "minor", bpm: 70,
    albums: [
      { title: "Slow Fire Cartography", year: 2018, tracks: ["I. Kindling", "II. Embers Map the Valley", "III. Cartographer's Lament", "IV. Heat Shimmer", "V. Glaze", "VI. What the Fire Kept", "VII. Cooling"] },
      { title: "Ashfall Suites", year: 2023, tracks: ["Ashfall", "Pyroclast", "Glass From Sand", "A Field After Burning", "Ember Choir", "Smoke Signal Requiem"] },
    ],
  },
  {
    name: "Neon Orchard", tags: ["Electronic", "Synthwave"], mood: "minor", bpm: 112,
    albums: [
      { title: "Afterglow Arcade", year: 2020, tracks: ["Afterglow Arcade", "High Score Heart", "Chrome Sunset", "Night Drive Protocol", "Pixel Rain", "Mirrorball Static", "Coin-Op Romance", "Laserdisc Summer", "Vapor Trails", "Continue?"] },
      { title: "Chrome Fruit", year: 2016, tracks: ["Chrome Fruit", "Electric Orchard", "Cherry Circuit", "Magenta Freeway", "Synthetic Peach", "Tangerine Grid", "Plum Voltage", "Hologram Harvest", "Neon Seeds"] },
    ],
  },
  {
    name: "Odessa Fen", tags: ["Folk", "Chamber Pop"], mood: "major", bpm: 88,
    albums: [
      { title: "Small Rooms", year: 2014, tracks: ["Small Rooms", "Teacups in the Attic", "Wallpaper Birds", "Piano in the Hall", "Lamp Oil", "The Quiet Neighbour", "Linen", "Window Seat", "Letters Unsent", "Candle Count"] },
      { title: "The Orchard Letters", year: 2019, tracks: ["Dear Orchard", "Pear Blossom", "Fen Song", "Cider Press", "Ladders & Baskets", "Frost on the Branches", "Bee Hum", "Second Picking", "Orchard Gate", "Windfall", "Last Letter Home"] },
    ],
  },
  {
    name: "Low Saturn Club", tags: ["Downtempo", "Jazz"], mood: "minor", bpm: 76, format: "flac",
    albums: [
      { title: "Velvet Hours", year: 2012, tracks: ["Velvet Hours", "Smoke Ring Blues", "Ninth Floor Lounge", "Saturn Return", "Brass in the Rain", "Midnight Ledger", "Blue Felt", "Low Orbit", "Closing Time Waltz"] },
      { title: "Late Set at the Meridian", year: 2017, tracks: ["Meridian Overture", "Upright & Unafraid", "Cigarette Moon", "Rhodes Less Travelled", "Ballad for the Barman", "Coat Check", "Encore in E-flat", "Taxi Rank"] },
    ],
  },
  {
    name: "Hollow Coast", tags: ["Indie Rock", "Krautrock"], mood: "minor", bpm: 124,
    albums: [
      { title: "Concrete Tides", year: 2013, tracks: ["Concrete Tides", "Motorik Shoreline", "Breakwater", "Iron Gull", "Pylon Song", "Tide Tables", "Grey Wave", "Harbour Machinery", "Salt Corrosion", "Coastline Loop"] },
    ],
  },
  {
    name: "Juniper Static", tags: ["Electronic", "Lo-Fi"], mood: "major", bpm: 80,
    albums: [
      { title: "Tape Hiss Lullabies", year: 2021, tracks: ["Rewind", "Cassette Dreams", "Rain on the Window", "Study Lamp", "Green Tea Loop", "Sleepy Cat", "Notebook Margins", "Bus Window", "Warm Static", "Sunday Laundry", "Dusty Keys", "Fade to Morning"] },
    ],
  },
  {
    name: "Calder & Wren", tags: ["Folk", "Acoustic"], mood: "major", bpm: 100,
    albums: [
      { title: "Lanterns for the Long Way", year: 2016, tracks: ["Long Way Round", "Wren's Reel", "Stone Bridge", "Fiddle in the Fog", "Hearthside", "Shepherd's Calendar", "Copper Kettle", "Hillside Hymn", "The Lantern Walk", "Homeward"] },
    ],
  },
  {
    name: "Mirror Lakes Society", tags: ["Dream Pop", "Psychedelic"], mood: "major", bpm: 108,
    albums: [
      { title: "Sunstroke Diaries", year: 2018, tracks: ["Sunstroke", "Kaleidoscope Mornings", "Lake Glass", "Dandelion Engine", "Paisley Weather", "Floating Pavilion", "Melted Clock Tower", "Golden Hour Parade", "Reflections"] },
      { title: "Colour Field Recordings", year: 2024, tracks: ["Colour Field", "Ultramarine", "Saffron Drift", "Violet Hour", "Cobalt Afternoon", "Chartreuse", "Vermilion Ghost", "Prism"] },
    ],
  },
  {
    name: "Ivory Vectors", tags: ["Downtempo", "Trip Hop"], mood: "minor", bpm: 90,
    albums: [
      { title: "Signal & Smoke", year: 2011, tracks: ["Signal", "Smoke", "Vector Ghosts", "Low Light Transmission", "Coded Rain", "Ivory Tower Dub", "Frequency Hymn", "Interference", "Night Relay", "Carrier Wave"] },
    ],
  },
  {
    name: "Ruby Atlas", tags: ["Downtempo", "Soul"], mood: "major", bpm: 94,
    albums: [
      { title: "Gold Hour Sermons", year: 2019, tracks: ["Gold Hour", "Sunday Sermon", "Honey & Rust", "Velvet Rope", "Call Me Sunrise", "Brass Heart", "Slow Dance Theory", "Tender Machine", "Golden Thread", "Amen in Amber"] },
    ],
  },
  {
    name: "Pale Meridian", tags: ["Dream Pop", "Shoegaze"], mood: "minor", bpm: 98,
    albums: [
      { title: "Wide Awake in Winter", year: 2015, tracks: ["Wide Awake", "Snowblind", "Fuzz Halo", "Frostbite Lovesong", "White Noise Waltz", "Hibernation", "Ice Fields", "Breathing Fog", "Thaw"] },
    ],
  },
  {
    name: "The Velour Engines", tags: ["Indie Rock", "Garage"], mood: "major", bpm: 140,
    albums: [
      { title: "Postcards from the Overpass", year: 2022, tracks: ["Overpass Postcard", "Velour", "Engine Room", "Parking Lot Prom", "Sunburn Radio", "Teenage Ghost Town", "Hot Asphalt", "Jukebox Martyr", "Drive-In Requiem", "Wheels Up", "Goodbye Freeway"] },
    ],
  },
  {
    name: "Sable Quinlan", tags: ["Folk", "Singer-Songwriter"], mood: "minor", bpm: 82,
    albums: [
      { title: "Saltwater Arithmetic", year: 2020, tracks: ["Saltwater Arithmetic", "Counting Gulls", "Lighthouse Keeper's Daughter", "Low Tide Confession", "Net Mender", "Shell Collection", "Undertow", "The Sum of Small Waves", "Keel", "Harbour Bell"] },
    ],
  },
  {
    name: "Tamsin Orrery", tags: ["Ambient", "Neoclassical"], mood: "minor", bpm: 66, format: "flac",
    albums: [
      { title: "Clockwork Snowfall", year: 2017, tracks: ["Orrery", "Clockwork Snowfall", "Planetarium", "Brass Gears in Winter", "Slow Orbit", "Escapement", "Starlight Mechanism", "Winding Down"] },
    ],
  },
  {
    name: "Driftwood Radio", tags: ["Folk", "Americana"], mood: "major", bpm: 104,
    albums: [
      { title: "Two-Lane Psalms", year: 2014, tracks: ["Two-Lane Psalm", "Diesel & Dust", "AM Gospel", "Truck Stop Halo", "Desert Motel", "Mesa", "Pedal Steel Prayer", "Rattlesnake Moon", "Last Exit Diner", "Signal Fades"] },
    ],
  },
  {
    name: "Cobalt Parade", tags: ["Electronic", "Synthpop"], mood: "major", bpm: 118,
    albums: [
      { title: "Heatwave Telegrams", year: 2023, tracks: ["Heatwave Telegram", "Cobalt", "Swimming Pool Static", "Parade Float", "Telegraph Hearts", "Sunglasses at Night School", "Tropical Depression", "Ice Lolly", "City Fountain", "Postcard Sky"] },
    ],
  },
  {
    name: "Hiraeth Sound System", tags: ["Downtempo", "Dub"], mood: "minor", bpm: 72,
    albums: [
      { title: "Harbour Lights Dub", year: 2016, tracks: ["Harbour Lights Dub", "Longing", "Echo Chamber Tide", "Bass Lantern", "Coastal Delay", "Homesick Riddim", "Reverb Lighthouse", "Fog Dub"] },
    ],
  },
];

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
  {
    artist: "Odessa Fen", title: "Small Rooms",
    lines: [
      [10, "There's a kettle on a stove that doesn't work"], [16, "and a chair that leans the way you used to lean"],
      [22, "there's a window full of chimneys and of birds"], [28, "and a calendar still stuck on seventeen"],
      [36, "Small rooms, small rooms"], [40, "hold the biggest things we knew"],
      [45, "small rooms, small rooms"], [49, "I keep every one for you"],
      [57, "There's a record with a scratch on side B"], [63, "where the chorus always skips a little beat"],
      [69, "and I never fixed it, never wanted to"], [75, "it's the only way that song sounds right to me"],
      [83, "Small rooms, small rooms"], [87, "hold the biggest things we knew"],
      [92, "small rooms, small rooms"], [96, "I keep every one for you"],
    ],
  },
  {
    artist: "The Paper Moths", title: "Night Bus Gospel",
    lines: [
      [14, "Top deck, front seat, city rolling by"], [19, "sodium halos on a rain-black sky"],
      [25, "driver's got the radio down low"], [30, "playing every song we used to know"],
      [37, "Sing it like a gospel on the night bus"], [42, "every stop a verse and every light a chorus"],
      [48, "nobody's going home and nobody's lost"], [53, "we're just singing on the night bus"],
      [61, "Fogged-up windows, names written in the glass"], [66, "kids from the kitchen on their way home from the late shift"],
      [72, "everybody tired, everybody kind"], [77, "for twenty minutes everybody's mine"],
      [85, "Sing it like a gospel on the night bus"], [90, "every stop a verse and every light a chorus"],
      [96, "nobody's going home and nobody's lost"], [101, "we're just singing on the night bus"],
    ],
  },
];

/** Which demo track each capture scene leans on, so `capture-site-media
 *  --demo` doesn't have to guess (the generator writes these into the
 *  manifest). */
export const SHOWCASE = {
  heroArtist: "Glass Harbour",
  lyrics: { artist: "Glass Harbour", title: "Paper Lanterns" },
  radioSeed: { artist: "Glass Harbour", title: "Harbour Lights" },
  detailAlbum: { artist: "Neon Orchard", title: "Afterglow Arcade" },
  detailTrack: { artist: "Glass Harbour", title: "Paper Lanterns" },
  // A FLAC for the "lossless" shot, by an artist the radio seed never reaches
  // (its station is Dream Pop): a track already in the queue confuses the
  // capture's play-it-then-undo step.
  lossless: { artist: "Tamsin Orrery", title: "Clockwork Snowfall" },
  searchQuery: "harbour",
};

const safe = (s) => s.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+$/, "");

/** Every track of the catalogue, flattened, with its on-disk location and a
 *  deterministic duration (seconds) in a plausible song range. */
export function catalogTracks() {
  const out = [];
  for (const artist of ARTISTS) {
    for (const album of artist.albums) {
      album.tracks.forEach((title, i) => {
        const r = rng(`${artist.name}|${album.title}|${title}`);
        const ext = artist.format === "flac" ? "flac" : "mp3";
        const lyrics = LYRICS.find((l) => l.artist === artist.name && l.title === title) ?? null;
        out.push({
          artist: artist.name, album: album.title, year: album.year, title,
          trackNumber: i + 1, trackTotal: album.tracks.length, tags: artist.tags,
          mood: artist.mood, bpm: artist.bpm, format: ext,
          // Songs with lyrics run long enough to hold every line.
          durationSecs: lyrics ? 168 + Math.round(r() * 40) : 150 + Math.round(r() * 170),
          dir: `${safe(artist.name)}/${album.year} - ${safe(album.title)}`,
          file: `${String(i + 1).padStart(2, "0")} - ${safe(title)}.${ext}`,
          lyrics,
        });
      });
    }
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
  const obsession = tracks.filter((t) => t.album === "Afterglow Arcade");
  for (let i = 0; i < 120; i++) add(obsession[Math.floor(r() * obsession.length)], r() * 14);
  // Forgotten favourites: heavy plays 150–220 days ago, nothing since.
  const forgotten = tracks.filter((t) => t.album === "Velvet Hours" || t.album === "Dust on the Dial");
  for (const t of forgotten) for (let i = 0; i < 6 + Math.floor(r() * 8); i++) add(t, 150 + r() * 70);
  const forgottenKeys = new Set(forgotten.map((t) => `${t.artist}|${t.title}`));
  return plays
    .filter((p) => !forgottenKeys.has(`${p.artist}|${p.title}`) || p.playedAt < now - 150 * DAY)
    .sort((a, b) => a.playedAt - b.playedAt);
}

/** Tracks / albums / artists the demo profile marks as liked. */
export function likePlan(tracks) {
  const liked = tracks.filter((t) => (hashString(`${t.artist}|${t.title}`) % 7 === 0) || t.title === "Paper Lanterns");
  return {
    tracks: liked.map((t) => ({ title: t.title, artistName: t.artist, albumTitle: t.album })),
    albums: [
      { title: "Tidewater Hymns", artistName: "Glass Harbour" },
      { title: "Afterglow Arcade", artistName: "Neon Orchard" },
      { title: "Small Rooms", artistName: "Odessa Fen" },
      { title: "Velvet Hours", artistName: "Low Saturn Club" },
      { title: "Colour Field Recordings", artistName: "Mirror Lakes Society" },
    ],
    artists: ["Glass Harbour", "Odessa Fen", "Neon Orchard"],
  };
}

/** SQL that writes `plays` into the history tables (canonical names are the
 *  lowercased names — the catalogue is ASCII, so no diacritics to strip; see
 *  `record_history_plays_batch`) and spreads the albums' `added_at` over the
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
    lines.push(`INSERT INTO history_artists (canonical_name, display_name, first_played_at, last_played_at, play_count) VALUES (${q(name.toLowerCase())}, ${q(name)}, ${a.first}, ${a.last}, ${a.count});`);
  }
  for (const s of songs.values()) {
    const artistId = `(SELECT id FROM history_artists WHERE canonical_name = ${q(s.artist.toLowerCase())})`;
    lines.push(`INSERT INTO history_tracks (history_artist_id, canonical_title, display_title, first_played_at, last_played_at, play_count) VALUES (${artistId}, ${q(s.title.toLowerCase())}, ${q(s.title)}, ${s.first}, ${s.last}, ${s.count});`);
    const trackId = `(SELECT id FROM history_tracks WHERE history_artist_id = ${artistId} AND canonical_title = ${q(s.title.toLowerCase())})`;
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
