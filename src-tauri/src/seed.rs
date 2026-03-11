use crate::db::Database;

/// Simple LCG-based PRNG for deterministic, dependency-free random numbers.
struct SimpleRng {
    state: u64,
}

impl SimpleRng {
    fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next(&mut self) -> u64 {
        self.state = self.state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.state
    }

    fn range(&mut self, min: u32, max: u32) -> u32 {
        let span = (max - min + 1) as u64;
        (self.next() % span) as u32 + min
    }

    fn pick<'a>(&mut self, list: &'a [&str]) -> &'a str {
        let idx = (self.next() % list.len() as u64) as usize;
        list[idx]
    }
}

const FIRST_NAMES: &[&str] = &[
    "Luna", "Kai", "Nova", "Zara", "Felix", "Aria", "Jasper", "Ivy",
    "Leo", "Maya", "Oscar", "Ruby", "Theo", "Vera", "Axel", "Cleo",
    "Dante", "Elena", "Finn", "Gaia", "Hugo", "Iris", "Jules", "Kira",
    "Milo", "Nora", "Raven", "Sage",
];

const LAST_NAMES: &[&str] = &[
    "Rivers", "Storm", "Blake", "Cross", "Vale", "Frost", "Drake", "Moon",
    "Stone", "Wells", "Hart", "Cole", "Grey", "Nash", "Knight", "Fox",
    "Reed", "Pierce", "Quinn", "Shaw", "Wolfe", "Crane", "Marsh", "Snow",
    "Vance", "Wood", "Lake", "Ridge",
];

const ADJECTIVES: &[&str] = &[
    "Midnight", "Golden", "Silent", "Electric", "Velvet", "Crystal", "Broken",
    "Neon", "Fading", "Endless", "Hidden", "Burning", "Frozen", "Hollow",
    "Crimson", "Distant", "Shallow", "Radiant", "Waking", "Phantom",
    "Emerald", "Floating", "Twisted", "Sacred", "Infinite",
];

const NOUNS: &[&str] = &[
    "Echoes", "Dreams", "Tides", "Shadows", "Light", "Rain", "Fire",
    "Waves", "Stars", "Dust", "Roads", "Hearts", "Sky", "Silence",
    "Gardens", "Mirrors", "Rivers", "Thunder", "Chains", "Embers",
    "Horizons", "Ruins", "Bridges", "Whispers", "Oceans",
];

const VERBS: &[&str] = &[
    "Dancing", "Falling", "Running", "Chasing", "Drifting", "Breaking",
    "Burning", "Fading", "Rising", "Spinning", "Waiting", "Calling",
    "Diving", "Flying", "Shining", "Walking", "Dreaming", "Floating",
    "Reaching", "Turning", "Wishing", "Breathing", "Wandering", "Healing",
    "Searching",
];

const GENRES: &[&str] = &[
    "Rock", "Pop", "Jazz", "Blues", "Electronic", "Hip Hop", "R&B",
    "Classical", "Folk", "Country", "Metal", "Punk", "Soul", "Reggae",
    "Indie",
];

pub fn seed_database(
    db: &Database,
    collection_id: i64,
    num_artists: u32,
    num_albums: u32,
    num_tracks: u32,
) -> Result<String, String> {
    let mut rng = SimpleRng::new(42);

    // Generate artists
    let mut artist_ids = Vec::with_capacity(num_artists as usize);
    for _ in 0..num_artists {
        let name = format!("{} {}", rng.pick(FIRST_NAMES), rng.pick(LAST_NAMES));
        let id = db.get_or_create_artist(&name).map_err(|e| e.to_string())?;
        artist_ids.push(id);
    }

    // Generate tags from genres
    let mut tag_ids = Vec::with_capacity(GENRES.len());
    for genre in GENRES {
        let id = db.get_or_create_tag(genre).map_err(|e| e.to_string())?;
        tag_ids.push(id);
    }

    // Generate albums, each assigned to a random artist
    let mut album_ids = Vec::with_capacity(num_albums as usize);
    let mut album_artists: Vec<i64> = Vec::with_capacity(num_albums as usize);
    let mut album_titles: Vec<String> = Vec::with_capacity(num_albums as usize);
    for _ in 0..num_albums {
        let title = format!("{} {}", rng.pick(ADJECTIVES), rng.pick(NOUNS));
        let artist_idx = (rng.next() % artist_ids.len() as u64) as usize;
        let artist_id = artist_ids[artist_idx];
        let year = rng.range(1970, 2025) as i32;
        let id = db
            .get_or_create_album(&title, Some(artist_id), Some(year))
            .map_err(|e| e.to_string())?;
        album_ids.push(id);
        album_artists.push(artist_id);
        album_titles.push(title);
    }

    // Generate tracks distributed across albums
    let mut track_counters = vec![0u32; num_albums as usize];
    for _ in 0..num_tracks {
        let album_idx = (rng.next() % album_ids.len() as u64) as usize;
        let album_id = album_ids[album_idx];
        let artist_id = album_artists[album_idx];

        track_counters[album_idx] += 1;
        let track_num = track_counters[album_idx];

        let title = format!("{} {}", rng.pick(VERBS), rng.pick(NOUNS));
        let tag_idx = (rng.next() % tag_ids.len() as u64) as usize;
        let tag_id = tag_ids[tag_idx];
        let duration = rng.range(120, 360) as f64;
        let file_size = rng.range(3_000_000, 10_000_000) as i64;

        // Build a fake artist name from the artist_id for path purposes
        let artist_name = format!("Artist{}", artist_id);
        let album_title = &album_titles[album_idx];
        let path = format!(
            "/fake/music/{}/{}/{:02} - {}.mp3",
            artist_name, album_title, track_num, title
        );

        let track_id = db.upsert_track(
            &path,
            &title,
            Some(artist_id),
            Some(album_id),
            Some(track_num as i32),
            Some(duration),
            Some("mp3"),
            Some(file_size),
            None,
            Some(collection_id),
            None,
        )
        .map_err(|e| e.to_string())?;
        db.add_track_tag(track_id, tag_id).map_err(|e| e.to_string())?;
    }

    db.rebuild_fts().map_err(|e| e.to_string())?;

    Ok(format!(
        "Seeded {} artists, {} albums, {} tracks",
        num_artists, num_albums, num_tracks
    ))
}
