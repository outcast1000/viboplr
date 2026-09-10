// Algorithmic ("auto") playlists.
//
// Unlike the protected `liked`/`disliked` system playlists (which project their
// membership from `entity_likes` on every read), auto-playlists are SNAPSHOTS:
// `ensure_auto_playlists` runs the generators and materializes the result into
// real `playlist_tracks` rows. They are `playlists` rows with
// `system_kind = "auto:<recipe>[:<key>]"`; `saved_at` doubles as the
// last-refreshed timestamp (24h staleness), and `metadata` holds the recipe spec.
//
// Every recipe depends on data a library may not have (play history, tags with a
// non-zero `track_count`, years, likes), so `ensure_auto_playlists` guarantees a
// floor of `MIN_AUTO_PLAYLISTS` by topping up with two fallback recipes seeded
// from liked/recently-played/random tracks. Those top-ups are pruned again as
// soon as the real recipes can fill the floor on their own.
//
// Shared types/helpers live in db/mod.rs; these are inherent `impl Database`
// methods reachable via `use super::*`.
use super::*;

/// Max tracks materialized per mix.
const MIX_LEN: u32 = 30;
/// A decade must have at least this many qualifying tracks to get a mix.
const MIN_DECADE_TRACKS: i64 = 12;
/// A mix is regenerated when its `saved_at` is older than this.
const AUTO_STALE_SECS: i64 = 24 * 60 * 60;
/// Forgotten cutoff for the discovery mix (tracks not played in this long).
const DISCOVERY_CUTOFF_SECS: i64 = 30 * 24 * 60 * 60;
/// Minimum number of mixes to surface. Every recipe above depends on data a
/// library may simply not have — play history, tags with a non-zero
/// `track_count`, years, likes — so a real (even large) library can legitimately
/// produce nothing. Below this count, fallback mixes are generated from the
/// liked/recently-played-weighted seed picker that Home's radio stations use,
/// falling back to a plain random slice of the library.
const MIN_AUTO_PLAYLISTS: usize = 3;
/// A seeded fallback station shorter than this is topped up with random tracks
/// rather than shipped as a two-track "mix".
const MIN_FALLBACK_LEN: usize = 5;

/// Top featured artists across the mix's tracks, ranked by track count
/// descending (ties keep first-seen order), capped at `max`. Mirrors the
/// frontend `featuredArtists` helper so card subtitles can read this straight
/// from metadata without loading every track. Blank artist names are skipped.
fn top_featured_artists(tracks: &[Track], max: usize) -> Vec<String> {
    let mut order: Vec<String> = Vec::new();
    let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for t in tracks {
        let name = match t.artist_name.as_deref() {
            Some(n) => n.trim(),
            None => continue,
        };
        if name.is_empty() {
            continue;
        }
        if !counts.contains_key(name) {
            order.push(name.to_string());
        }
        *counts.entry(name.to_string()).or_insert(0) += 1;
    }
    // Stable sort by count desc keeps first-seen order for ties.
    order.sort_by(|a, b| counts[b].cmp(&counts[a]));
    order.truncate(max);
    order
}

/// Merge track-derived facts into a mix's recipe metadata JSON: `first_artist`
/// (so the UI can resolve a cover image) and `featured_artists` (a short,
/// ranked artist list for the card subtitle, Spotify "Daily Mix" style).
/// Tolerant of malformed input.
fn merge_track_facts(metadata: &str, first_artist: Option<&str>, featured: &[String]) -> String {
    let mut v: serde_json::Value =
        serde_json::from_str(metadata).unwrap_or_else(|_| serde_json::json!({}));
    if let Some(obj) = v.as_object_mut() {
        obj.insert(
            "first_artist".to_string(),
            match first_artist {
                Some(a) => serde_json::Value::String(a.to_string()),
                None => serde_json::Value::Null,
            },
        );
        obj.insert(
            "featured_artists".to_string(),
            serde_json::Value::Array(
                featured.iter().map(|a| serde_json::Value::String(a.clone())).collect(),
            ),
        );
    }
    v.to_string()
}

/// Which generator a desired auto-playlist maps to.
enum Recipe {
    DailyMix { artist: String, seed_title: Option<String> },
    Genre { tag_id: i64 },
    Decade { start: i32, end: i32 },
    Discovery,
    /// Fallback: a radio station from an arbitrary seed (liked / recently played
    /// / random, per `pick_radio_seeds`), topped up with random tracks when the
    /// station comes back thin.
    SeededFallback { artist: String, seed_title: String },
    /// Last-resort fallback: a random slice of the library. `index` offsets into
    /// the random ordering so several samplers don't serve the same tracks.
    Sampler { index: u32 },
}

/// A desired auto-playlist: its identity (`kind`), display `name`, recipe `metadata`
/// JSON, and the `recipe` used to (re)generate its tracks.
struct AutoSpec {
    kind: String,
    name: String,
    metadata: String,
    recipe: Recipe,
}

impl Database {
    // --- Public generators (also unit-tested directly) ---

    /// Per-artist radio mix. Reuses the existing radio engine. When `seed_title`
    /// is absent, picks a representative track for the artist as the seed.
    pub fn generate_daily_mix(&self, seed_artist: &str, seed_title: Option<&str>, count: u32) -> SqlResult<Vec<Track>> {
        if count == 0 {
            return Ok(Vec::new());
        }
        let title: String = match seed_title {
            Some(t) => t.to_string(),
            None => {
                let canonical_artist = strip_diacritics(&seed_artist.to_lowercase());
                let picked: Option<String> = {
                    let conn = self.conn.lock().unwrap();
                    let sql = format!(
                        "{} WHERE strip_diacritics(unicode_lower(COALESCE(ar.name, ''))) = ?1 \
                         AND t.liked != -1 {} ORDER BY RANDOM() LIMIT 1",
                        TRACK_SELECT, ENABLED_COLLECTION_FILTER
                    );
                    conn.query_row(&sql, params![canonical_artist], |row| track_from_row(row))
                        .optional()?
                        .map(|t| t.title)
                };
                match picked {
                    Some(t) => t,
                    None => return Ok(Vec::new()),
                }
            }
        };
        // build_radio_for_track acquires its own lock; the scope above has dropped ours.
        self.build_radio_for_track(&title, Some(seed_artist), count)
    }

    /// Random sample of (non-disliked) tracks carrying a given tag.
    pub fn generate_genre_mix(&self, tag_id: i64, count: u32) -> SqlResult<Vec<Track>> {
        if count == 0 {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "{} WHERE t.liked != -1 {} \
             AND t.id IN (SELECT DISTINCT track_id FROM track_tags WHERE tag_id = ?1) \
             ORDER BY RANDOM() LIMIT ?2",
            TRACK_SELECT, ENABLED_COLLECTION_FILTER
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![tag_id, count as i64], |row| track_from_row(row))?;
        rows.collect()
    }

    /// Random sample of (non-disliked) tracks whose year (track, falling back to
    /// album) falls within `[start, end]`.
    pub fn generate_decade_mix(&self, start: i32, end: i32, count: u32) -> SqlResult<Vec<Track>> {
        if count == 0 {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "{} WHERE t.liked != -1 {} \
             AND COALESCE(t.year, al.year) BETWEEN ?1 AND ?2 \
             ORDER BY RANDOM() LIMIT ?3",
            TRACK_SELECT, ENABLED_COLLECTION_FILTER
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![start, end, count as i64], |row| track_from_row(row))?;
        rows.collect()
    }

    /// Liked-but-forgotten library tracks: liked (per the authoritative
    /// `entity_likes` store) and either never played or not played since the
    /// forgotten cutoff. Never-played first, then oldest, with a random tiebreak.
    pub fn generate_discovery_mix(&self, count: u32) -> SqlResult<Vec<Track>> {
        if count == 0 {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "{} \
             LEFT JOIN history_artists ha ON ha.canonical_name = strip_diacritics(unicode_lower(COALESCE(ar.name, ''))) \
             LEFT JOIN history_tracks ht ON ht.history_artist_id = ha.id \
                  AND ht.canonical_title = strip_diacritics(unicode_lower(t.title)) \
             WHERE t.liked != -1 {} \
               AND EXISTS ( \
                 SELECT 1 FROM entity_likes el \
                 WHERE el.kind = 'track' AND el.liked = 1 \
                   AND el.entity_key = 'track:' \
                     || strip_diacritics(unicode_lower(COALESCE(ar.name, ''))) || ':' \
                     || strip_diacritics(unicode_lower(t.title)) \
               ) \
               AND (ht.last_played_at IS NULL OR ht.last_played_at < (CAST(strftime('%s','now') AS INTEGER) - ?1)) \
             GROUP BY t.id \
             ORDER BY COALESCE(ht.last_played_at, 0) ASC, RANDOM() \
             LIMIT ?2",
            TRACK_SELECT, ENABLED_COLLECTION_FILTER
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![DISCOVERY_CUTOFF_SECS, count as i64], |row| track_from_row(row))?;
        rows.collect()
    }

    /// A random slice of the (non-disliked, enabled-collection) library. `index`
    /// skips `index * count` rows of the random ordering, so sampler 0 and
    /// sampler 1 don't overlap within a run.
    pub fn generate_sampler_mix(&self, index: u32, count: u32) -> SqlResult<Vec<Track>> {
        if count == 0 {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "{} WHERE t.liked != -1 {} ORDER BY RANDOM() LIMIT ?1 OFFSET ?2",
            TRACK_SELECT, ENABLED_COLLECTION_FILTER
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut slice = |offset: i64| -> SqlResult<Vec<Track>> {
            let rows = stmt.query_map(params![count as i64, offset], |row| track_from_row(row))?;
            rows.collect()
        };
        let tracks = slice((index as i64) * (count as i64))?;
        if !tracks.is_empty() || index == 0 {
            return Ok(tracks);
        }
        // A library smaller than `index * count` has no disjoint slice left.
        // Overlapping mixes beat an empty section, so start over from the top.
        slice(0)
    }

    /// Pad `tracks` up to `target` with random library tracks it doesn't already
    /// contain. Used when a fallback station's seed has too few neighbours to
    /// fill a mix — a 2-track card reads as broken, and the alternative to
    /// padding is showing nothing at all.
    fn fill_with_random(&self, tracks: &mut Vec<Track>, target: u32) -> SqlResult<()> {
        if tracks.len() >= target as usize {
            return Ok(());
        }
        let want = target as usize - tracks.len();
        let exclude: Vec<String> = tracks.iter().map(|t| t.id.to_string()).collect();
        let exclude_clause = if exclude.is_empty() {
            String::new()
        } else {
            format!(" AND t.id NOT IN ({})", exclude.join(","))
        };
        let extra: Vec<Track> = {
            let conn = self.conn.lock().unwrap();
            let sql = format!(
                "{} WHERE t.liked != -1 {}{} ORDER BY RANDOM() LIMIT ?1",
                TRACK_SELECT, ENABLED_COLLECTION_FILTER, exclude_clause
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params![want as i64], |row| track_from_row(row))?;
            rows.collect::<SqlResult<Vec<_>>>()?
        };
        tracks.extend(extra);
        Ok(())
    }

    // --- Orchestrator ---

    /// Decide which auto-playlists should exist, (re)generate stale/missing ones
    /// into materialized `playlist_tracks`, top the result up to
    /// `MIN_AUTO_PLAYLISTS`, and prune whatever is no longer wanted. `force`
    /// regenerates everything regardless of `saved_at` age. A single failing
    /// generator is logged and skipped (the batch continues).
    ///
    /// Pruning runs LAST because the fallback set isn't known until the recipe
    /// mixes have been generated: a spec can exist and still yield nothing.
    pub fn ensure_auto_playlists(&self, force: bool) -> SqlResult<()> {
        // Dedupe by kind: `top_daily_artists` can return two seeds by the same
        // artist (its radio-seed fallback only prefers distinct artists), which
        // yields two specs with one kind — and would then count twice towards
        // MIN_AUTO_PLAYLISTS.
        let mut seen_kinds: std::collections::HashSet<String> = std::collections::HashSet::new();
        let specs: Vec<AutoSpec> = self
            .desired_auto_specs()?
            .into_iter()
            .filter(|s| seen_kinds.insert(s.kind.clone()))
            .collect();
        let mut desired: std::collections::HashSet<String> = seen_kinds;

        let now = self.auto_now_ts()?;
        let mut live = 0usize;
        for spec in &specs {
            if self.materialize_spec(spec, now, force)? {
                live += 1;
            }
        }

        // Top up. Existing fallback rows are reused (so their names and 24h
        // snapshots stay put across launches) before new seeds are drawn, and
        // once the recipe mixes recover, the leftovers fall out of `desired` and
        // are pruned below.
        if live < MIN_AUTO_PLAYLISTS {
            let fallbacks = self.fallback_specs(MIN_AUTO_PLAYLISTS - live, &desired)?;
            for spec in &fallbacks {
                if self.materialize_spec(spec, now, force)? {
                    desired.insert(spec.kind.clone());
                }
            }
        }

        self.prune_auto_playlists(&desired)?;
        Ok(())
    }

    /// Generate one spec into its row when stale, and report whether a non-empty
    /// mix exists for it afterwards. An empty generator result drops the row
    /// (nothing persists an empty mix), so the returned flag is what the
    /// `MIN_AUTO_PLAYLISTS` top-up counts.
    fn materialize_spec(&self, spec: &AutoSpec, now: i64, force: bool) -> SqlResult<bool> {
        let existing = self.get_auto_row(&spec.kind)?;
        let stale = force
            || match existing {
                Some((_, saved_at)) => (now - saved_at) > AUTO_STALE_SECS,
                None => true,
            };
        if !stale {
            // A fresh row is always non-empty — empty mixes are never persisted.
            return Ok(true);
        }
        let tracks = match self.generate_auto_tracks(&spec.recipe) {
            Ok(t) => t,
            Err(e) => {
                log::warn!("auto-playlist '{}' generation failed: {}", spec.kind, e);
                // Keep (and count) a previous snapshot rather than dropping a
                // usable mix because one regeneration failed.
                return Ok(existing.is_some());
            }
        };
        if tracks.is_empty() {
            // Don't persist empty mixes; drop any stale placeholder row.
            if let Some((id, _)) = existing {
                let _ = self.delete_auto_row_by_id(id);
            }
            return Ok(false);
        }
        let id = match existing {
            Some((id, _)) => id,
            None => self.insert_auto_row(spec)?,
        };
        self.replace_auto_tracks(id, spec, &tracks, now)?;
        Ok(true)
    }

    /// Up to `need` fallback specs: existing fallback rows first (reused as-is),
    /// then fresh seeds from `pick_radio_seeds` (liked and recently-played
    /// tracks are weighted to the top, the rest is random — so the mixes are
    /// personal when there's anything to be personal about), then plain random
    /// samplers for a library with no usable artist names at all.
    fn fallback_specs(
        &self,
        need: usize,
        taken: &std::collections::HashSet<String>,
    ) -> SqlResult<Vec<AutoSpec>> {
        let mut specs: Vec<AutoSpec> = Vec::new();

        for (kind, name, metadata) in self.list_fallback_rows()? {
            if specs.len() >= need {
                break;
            }
            if let Some(recipe) = Self::fallback_recipe_from_metadata(&metadata) {
                specs.push(AutoSpec { kind, name, metadata, recipe });
            }
        }

        if specs.len() < need {
            // Overdraw: seeds without an artist name, and artists a daily mix
            // already covers, are skipped.
            let seeds = self.pick_radio_seeds(((need - specs.len()) * 4).max(4) as u32)?;
            for seed in seeds {
                if specs.len() >= need {
                    break;
                }
                let artist = match seed.artist_name.as_deref().map(str::trim) {
                    Some(a) if !a.is_empty() => a.to_string(),
                    _ => continue,
                };
                let canon = strip_diacritics(&artist.to_lowercase());
                let kind = format!("auto:seeded:{}", canon);
                // Same artist as a daily mix → same card name; skip it.
                if taken.contains(&kind)
                    || taken.contains(&format!("auto:daily-mix:{}", canon))
                    || specs.iter().any(|s| s.kind == kind)
                {
                    continue;
                }
                specs.push(AutoSpec {
                    kind,
                    name: format!("{} Mix", artist),
                    metadata: serde_json::json!({
                        "recipe": "seeded",
                        "seed_artist": artist,
                        "seed_title": seed.title,
                    })
                    .to_string(),
                    recipe: Recipe::SeededFallback { artist, seed_title: seed.title },
                });
            }
        }

        // Nothing seedable (no artist names anywhere) — hand out random slices.
        let mut index = 0u32;
        while specs.len() < need && index < MIN_AUTO_PLAYLISTS as u32 * 2 {
            let kind = format!("auto:sampler:{}", index);
            if !taken.contains(&kind) && !specs.iter().any(|s| s.kind == kind) {
                specs.push(AutoSpec {
                    kind,
                    name: if index == 0 {
                        "Library Mix".to_string()
                    } else {
                        format!("Library Mix {}", index + 1)
                    },
                    metadata: serde_json::json!({ "recipe": "sampler", "index": index }).to_string(),
                    recipe: Recipe::Sampler { index },
                });
            }
            index += 1;
        }

        Ok(specs)
    }

    /// Rebuild a fallback recipe from a stored row's metadata. Returns `None`
    /// for anything unrecognised, so a row written by a future (or corrupted)
    /// build is simply not reused — it falls out of `desired` and is pruned.
    fn fallback_recipe_from_metadata(metadata: &str) -> Option<Recipe> {
        let v: serde_json::Value = serde_json::from_str(metadata).ok()?;
        match v.get("recipe")?.as_str()? {
            "seeded" => {
                let artist = v.get("seed_artist")?.as_str()?.to_string();
                let seed_title = v.get("seed_title")?.as_str()?.to_string();
                Some(Recipe::SeededFallback { artist, seed_title })
            }
            "sampler" => Some(Recipe::Sampler {
                index: v.get("index")?.as_u64()? as u32,
            }),
            _ => None,
        }
    }

    fn generate_auto_tracks(&self, recipe: &Recipe) -> SqlResult<Vec<Track>> {
        match recipe {
            Recipe::DailyMix { artist, seed_title } => {
                self.generate_daily_mix(artist, seed_title.as_deref(), MIX_LEN)
            }
            Recipe::Genre { tag_id } => self.generate_genre_mix(*tag_id, MIX_LEN),
            Recipe::Decade { start, end } => self.generate_decade_mix(*start, *end, MIX_LEN),
            Recipe::Discovery => self.generate_discovery_mix(MIX_LEN),
            Recipe::SeededFallback { artist, seed_title } => {
                let mut tracks = self.build_radio_for_track(seed_title, Some(artist), MIX_LEN)?;
                if tracks.len() < MIN_FALLBACK_LEN {
                    self.fill_with_random(&mut tracks, MIX_LEN)?;
                }
                Ok(tracks)
            }
            Recipe::Sampler { index } => self.generate_sampler_mix(*index, MIX_LEN),
        }
    }

    /// Build the desired set of auto-playlists from the current library.
    fn desired_auto_specs(&self) -> SqlResult<Vec<AutoSpec>> {
        let mut specs: Vec<AutoSpec> = Vec::new();

        // Daily mixes — up to 3, seeded from the most-played artists (falling
        // back to weighted radio seeds for a fresh, history-less library).
        for (artist, seed_title) in self.top_daily_artists(3)? {
            let canon = strip_diacritics(&artist.to_lowercase());
            specs.push(AutoSpec {
                kind: format!("auto:daily-mix:{}", canon),
                name: format!("{} Mix", artist),
                metadata: serde_json::json!({
                    "recipe": "daily-mix",
                    "seed_artist": artist,
                    "seed_title": seed_title,
                })
                .to_string(),
                recipe: Recipe::DailyMix { artist, seed_title },
            });
        }

        // Genre mixes — up to 3, the most-used tags.
        for (tag_id, tag_name) in self.top_genre_tags(3)? {
            let canon = strip_diacritics(&tag_name.to_lowercase());
            specs.push(AutoSpec {
                kind: format!("auto:genre:{}", canon),
                name: format!("{} Mix", tag_name),
                metadata: serde_json::json!({
                    "recipe": "genre",
                    "tag": tag_name,
                    "tag_id": tag_id,
                })
                .to_string(),
                recipe: Recipe::Genre { tag_id },
            });
        }

        // Decade mixes — up to 2 of the most-populated decades.
        for decade in self.top_decades(2)? {
            specs.push(AutoSpec {
                kind: format!("auto:decade:{}s", decade),
                name: format!("{}s", decade),
                metadata: serde_json::json!({
                    "recipe": "decade",
                    "start": decade,
                    "end": decade + 9,
                })
                .to_string(),
                recipe: Recipe::Decade { start: decade, end: decade + 9 },
            });
        }

        // Discovery — always desired; the empty-skip path drops it when the
        // library has no liked-but-forgotten tracks.
        specs.push(AutoSpec {
            kind: "auto:discovery".to_string(),
            name: "Discovery".to_string(),
            metadata: serde_json::json!({ "recipe": "discovery" }).to_string(),
            recipe: Recipe::Discovery,
        });

        Ok(specs)
    }

    /// Most-played library artists by play history; `(artist_name, seed_title?)`.
    /// Falls back to weighted radio seeds (which carry a concrete seed title)
    /// when there is no play history yet.
    fn top_daily_artists(&self, limit: usize) -> SqlResult<Vec<(String, Option<String>)>> {
        let artists: Vec<String> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT ar.name FROM history_artists ha \
                 JOIN artists ar ON strip_diacritics(unicode_lower(ar.name)) = ha.canonical_name \
                 WHERE ar.track_count > 0 \
                 ORDER BY ha.play_count DESC, ha.last_played_at DESC LIMIT ?1",
            )?;
            let rows = stmt.query_map(params![limit as i64], |row| row.get::<_, String>(0))?;
            rows.collect::<SqlResult<_>>()?
        };
        if !artists.is_empty() {
            return Ok(artists.into_iter().map(|a| (a, None)).collect());
        }
        // Fallback: radio seeds give us (artist, concrete seed title) pairs.
        let seeds = self.pick_radio_seeds(limit as u32)?;
        Ok(seeds
            .into_iter()
            .filter_map(|t| t.artist_name.map(|a| (a, Some(t.title))))
            .collect())
    }

    /// Most-used tags (by denormalized track_count).
    fn top_genre_tags(&self, limit: usize) -> SqlResult<Vec<(i64, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name FROM tags WHERE track_count > 0 ORDER BY track_count DESC, name LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect()
    }

    /// Most-populated decades (only those with enough tracks to be worth a mix).
    fn top_decades(&self, limit: usize) -> SqlResult<Vec<i32>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "SELECT (COALESCE(t.year, al.year) / 10) * 10 AS decade, COUNT(*) c \
             FROM tracks t LEFT JOIN albums al ON t.album_id = al.id \
             LEFT JOIN collections co ON t.collection_id = co.id \
             WHERE COALESCE(t.year, al.year) IS NOT NULL AND t.liked != -1 {} \
             GROUP BY decade HAVING c >= ?1 ORDER BY c DESC LIMIT ?2",
            ENABLED_COLLECTION_FILTER
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![MIN_DECADE_TRACKS, limit as i64], |row| row.get::<_, i32>(0))?;
        rows.collect()
    }

    // --- Row helpers (each acquires the lock briefly) ---

    fn auto_now_ts(&self) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT strftime('%s','now')", [], |row| {
            let s: String = row.get(0)?;
            Ok(s.parse::<i64>().unwrap_or(0))
        })
    }

    fn get_auto_row(&self, kind: &str) -> SqlResult<Option<(i64, i64)>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, saved_at FROM playlists WHERE system_kind = ?1",
            params![kind],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
    }

    /// Existing fallback rows as `(kind, name, metadata)`, oldest first so the
    /// reuse order is stable across runs.
    fn list_fallback_rows(&self) -> SqlResult<Vec<(String, String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT system_kind, name, COALESCE(metadata, '') FROM playlists \
             WHERE system_kind LIKE 'auto:seeded:%' OR system_kind LIKE 'auto:sampler:%' \
             ORDER BY id",
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        rows.collect()
    }

    fn insert_auto_row(&self, spec: &AutoSpec) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO playlists (name, system_kind, metadata) VALUES (?1, ?2, ?3)",
            params![spec.name, spec.kind, spec.metadata],
        )?;
        Ok(conn.last_insert_rowid())
    }

    fn delete_auto_row_by_id(&self, id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM playlists WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Prune existing `auto:%` rows whose kind is no longer desired (cascade
    /// clears their `playlist_tracks`).
    fn prune_auto_playlists(&self, desired: &std::collections::HashSet<String>) -> SqlResult<()> {
        let existing: Vec<(i64, String)> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt =
                conn.prepare("SELECT id, system_kind FROM playlists WHERE system_kind LIKE 'auto:%'")?;
            let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect::<SqlResult<_>>()?
        };
        for (id, kind) in existing {
            if !desired.contains(&kind) {
                let conn = self.conn.lock().unwrap();
                conn.execute("DELETE FROM playlists WHERE id = ?1", params![id])?;
            }
        }
        Ok(())
    }

    /// Replace a mix's materialized tracks and stamp `saved_at = now`.
    fn replace_auto_tracks(&self, playlist_id: i64, spec: &AutoSpec, tracks: &[Track], now: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM playlist_tracks WHERE playlist_id = ?1", params![playlist_id])?;
        {
            let mut stmt = conn.prepare(
                "INSERT INTO playlist_tracks \
                 (playlist_id, position, title, artist_name, album_name, duration_secs, source, image_path) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)",
            )?;
            for (i, t) in tracks.iter().enumerate() {
                // `t.path` is the full scheme-prefixed URI from TRACK_SELECT — playable.
                // image_path stays NULL so the frontend resolves art via the
                // name-based chain (album → artist → placeholder).
                stmt.execute(params![
                    playlist_id,
                    i as i64,
                    t.title,
                    t.artist_name,
                    t.album_title,
                    t.duration_secs,
                    t.path,
                ])?;
            }
        }
        // Record the first track's artist (cover image) plus the top featured
        // artists (card subtitle) in metadata so the UI needs neither a cover
        // lookup nor the full track list to describe the mix.
        let first_artist = tracks.first().and_then(|t| t.artist_name.clone());
        let featured = top_featured_artists(tracks, 4);
        let metadata = merge_track_facts(&spec.metadata, first_artist.as_deref(), &featured);
        conn.execute(
            "UPDATE playlists SET name = ?1, metadata = ?2, saved_at = ?3 WHERE id = ?4",
            params![spec.name, metadata, now, playlist_id],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::likes::build_entity_key;

    fn test_db() -> Database {
        Database::new_in_memory().unwrap()
    }

    fn add_local_collection(db: &Database) -> i64 {
        db.add_collection("local", "L", Some("/m"), None, None, None, None, None)
            .unwrap()
            .id
    }

    fn mk_track(
        db: &Database,
        cid: i64,
        path: &str,
        title: &str,
        artist: i64,
        album: Option<i64>,
        year: Option<i32>,
    ) -> i64 {
        db.upsert_track(path, title, Some(artist), album, None, Some(180.0), Some("mp3"), None, None, Some(cid), year)
            .unwrap()
    }

    fn count_kind_like(db: &Database, pattern: &str) -> i64 {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM playlists WHERE system_kind LIKE ?1",
            params![pattern],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn test_generate_genre_mix_returns_only_tagged_non_disliked() {
        let db = test_db();
        let cid = add_local_collection(&db);
        let artist = db.get_or_create_artist("A").unwrap();
        let rock = db.get_or_create_tag("rock").unwrap();
        let jazz = db.get_or_create_tag("jazz").unwrap();
        let t1 = mk_track(&db, cid, "r1.mp3", "R1", artist, None, None);
        let t2 = mk_track(&db, cid, "r2.mp3", "R2", artist, None, None);
        let tj = mk_track(&db, cid, "j1.mp3", "J1", artist, None, None);
        let tdis = mk_track(&db, cid, "rd.mp3", "RD", artist, None, None);
        db.add_track_tag(t1, rock).unwrap();
        db.add_track_tag(t2, rock).unwrap();
        db.add_track_tag(tj, jazz).unwrap();
        db.add_track_tag(tdis, rock).unwrap();
        db.toggle_liked("tracks", tdis, -1).unwrap();
        db.recompute_counts().unwrap();

        let mix = db.generate_genre_mix(rock, 30).unwrap();
        let ids: std::collections::HashSet<i64> = mix.iter().map(|t| t.id).collect();
        assert!(ids.contains(&t1) && ids.contains(&t2), "both rock tracks present");
        assert!(!ids.contains(&tj), "jazz track must not be in rock mix");
        assert!(!ids.contains(&tdis), "disliked track must be excluded");
        assert!(mix.len() <= 30);
    }

    #[test]
    fn test_generate_decade_mix_year_coalesce() {
        let db = test_db();
        let cid = add_local_collection(&db);
        let artist = db.get_or_create_artist("A").unwrap();
        let album = db.get_or_create_album("Alb", Some(artist), Some(1995)).unwrap();
        // Track has no year; album does → COALESCE(t.year, al.year) places it in the 1990s.
        let t = mk_track(&db, cid, "a.mp3", "A1", artist, Some(album), None);
        db.recompute_counts().unwrap();

        let mix = db.generate_decade_mix(1990, 1999, 30).unwrap();
        let ids: std::collections::HashSet<i64> = mix.iter().map(|t| t.id).collect();
        assert!(ids.contains(&t), "album-year fallback should place the track in the 1990s mix");
    }

    #[test]
    fn test_generate_decade_mix_empty_for_unpopulated() {
        let db = test_db();
        let cid = add_local_collection(&db);
        let artist = db.get_or_create_artist("A").unwrap();
        let _ = mk_track(&db, cid, "a.mp3", "A1", artist, None, None); // no year anywhere
        let mix = db.generate_decade_mix(1980, 1989, 30).unwrap();
        assert!(mix.is_empty());
    }

    #[test]
    fn test_generate_daily_mix_starts_with_artist() {
        let db = test_db();
        let cid = add_local_collection(&db);
        let artist = db.get_or_create_artist("Radiohead").unwrap();
        mk_track(&db, cid, "creep.mp3", "Creep", artist, None, None);
        mk_track(&db, cid, "karma.mp3", "Karma Police", artist, None, None);
        mk_track(&db, cid, "no.mp3", "No Surprises", artist, None, None);
        db.recompute_counts().unwrap();

        let mix = db.generate_daily_mix("Radiohead", Some("Creep"), 5).unwrap();
        assert!(!mix.is_empty());
        assert_eq!(mix[0].title, "Creep", "seed is element 0");
        assert!(mix.iter().all(|t| t.artist_name.as_deref() == Some("Radiohead")));
    }

    #[test]
    fn test_generate_discovery_excludes_recently_played() {
        let db = test_db();
        let cid = add_local_collection(&db);
        let artist = db.get_or_create_artist("A").unwrap();
        let played = mk_track(&db, cid, "p.mp3", "Played", artist, None, None);
        let never = mk_track(&db, cid, "n.mp3", "Never", artist, None, None);
        // Liked via the authoritative entity_likes store.
        db.set_entity_like("track", &build_entity_key("track", "Played", Some("A")), 1, None, 100).unwrap();
        db.set_entity_like("track", &build_entity_key("track", "Never", Some("A")), 1, None, 101).unwrap();
        db.record_history_play(played).unwrap(); // recent play for `played`
        db.recompute_counts().unwrap();

        let mix = db.generate_discovery_mix(30).unwrap();
        let ids: std::collections::HashSet<i64> = mix.iter().map(|t| t.id).collect();
        assert!(ids.contains(&never), "never-played liked track should appear");
        assert!(!ids.contains(&played), "recently-played liked track should be excluded");
    }

    #[test]
    fn test_ensure_auto_playlists_materializes_rows() {
        let db = test_db();
        let cid = add_local_collection(&db);
        let artist = db.get_or_create_artist("A").unwrap();
        let rock = db.get_or_create_tag("rock").unwrap();
        for i in 0..5 {
            let id = mk_track(&db, cid, &format!("r{}.mp3", i), &format!("R{}", i), artist, None, None);
            db.add_track_tag(id, rock).unwrap();
        }
        db.recompute_counts().unwrap();
        db.ensure_auto_playlists(true).unwrap();

        let (pid, kind, cnt): (i64, String, i64) = {
            let conn = db.conn.lock().unwrap();
            conn.query_row(
                "SELECT p.id, p.system_kind, \
                 (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = p.id) \
                 FROM playlists p WHERE p.system_kind LIKE 'auto:genre:%' LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap()
        };
        assert!(kind.starts_with("auto:genre:"));
        assert!(cnt > 0, "materialized tracks present");
        // Reads via the real-rows path (proves the auto bail), not the like projection.
        let tracks = db.get_playlist_tracks(pid).unwrap();
        assert_eq!(tracks.len() as i64, cnt);
    }

    #[test]
    fn test_ensure_auto_writes_first_artist_metadata() {
        let db = test_db();
        let cid = add_local_collection(&db);
        let artist = db.get_or_create_artist("Radiohead").unwrap();
        let rock = db.get_or_create_tag("rock").unwrap();
        for i in 0..5 {
            let id = mk_track(&db, cid, &format!("r{}.mp3", i), &format!("R{}", i), artist, None, None);
            db.add_track_tag(id, rock).unwrap();
        }
        db.recompute_counts().unwrap();
        db.ensure_auto_playlists(true).unwrap();

        let meta: String = {
            let conn = db.conn.lock().unwrap();
            conn.query_row(
                "SELECT metadata FROM playlists WHERE system_kind = 'auto:genre:rock'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        let v: serde_json::Value = serde_json::from_str(&meta).unwrap();
        assert_eq!(v.get("first_artist").and_then(|x| x.as_str()), Some("Radiohead"));
        // The original recipe spec is preserved alongside the injected field.
        assert_eq!(v.get("recipe").and_then(|x| x.as_str()), Some("genre"));
        // Featured artists are recorded for the card subtitle.
        let featured: Vec<&str> = v
            .get("featured_artists")
            .and_then(|x| x.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
            .unwrap_or_default();
        assert_eq!(featured, vec!["Radiohead"]);
    }

    #[test]
    fn test_top_featured_artists_ranks_by_count() {
        let mk = |artist: Option<&str>| Track {
            id: 0,
            path: String::new(),
            title: String::new(),
            artist_id: None,
            artist_name: artist.map(|s| s.to_string()),
            album_id: None,
            album_title: None,
            year: None,
            track_number: None,
            duration_secs: None,
            format: None,
            file_size: None,
            collection_id: None,
            collection_name: None,
            liked: 0,
            added_at: None,
            modified_at: None,
            album_artist_name: None,
        };
        let tracks = vec![
            mk(Some("A")),
            mk(Some("B")),
            mk(Some("A")),
            mk(Some("  ")), // blank → skipped
            mk(None),       // none → skipped
            mk(Some("C")),
            mk(Some("B")),
        ];
        // A:2, B:2, C:1 — A before B (first-seen tie), C last.
        assert_eq!(top_featured_artists(&tracks, 4), vec!["A", "B", "C"]);
        // Respects the cap.
        assert_eq!(top_featured_artists(&tracks, 2), vec!["A", "B"]);
    }

    #[test]
    fn test_ensure_auto_skips_empty() {
        let db = test_db();
        db.ensure_auto_playlists(true).unwrap();
        assert_eq!(count_kind_like(&db, "auto:%"), 0, "no auto playlists for an empty library");
    }

    #[test]
    fn test_ensure_auto_idempotent_and_staleness() {
        let db = test_db();
        let cid = add_local_collection(&db);
        let artist = db.get_or_create_artist("A").unwrap();
        let rock = db.get_or_create_tag("rock").unwrap();
        for i in 0..5 {
            let id = mk_track(&db, cid, &format!("r{}.mp3", i), &format!("R{}", i), artist, None, None);
            db.add_track_tag(id, rock).unwrap();
        }
        db.recompute_counts().unwrap();

        let saved_at = |db: &Database| -> i64 {
            let conn = db.conn.lock().unwrap();
            conn.query_row(
                "SELECT saved_at FROM playlists WHERE system_kind LIKE 'auto:genre:%' LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };

        db.ensure_auto_playlists(false).unwrap();
        let s1 = saved_at(&db);
        db.ensure_auto_playlists(false).unwrap();
        assert_eq!(s1, saved_at(&db), "a fresh mix must not be regenerated");

        // Backdate beyond the staleness window → regenerated, saved_at bumped.
        let backdated = s1 - 2 * 24 * 60 * 60;
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE playlists SET saved_at = ?1 WHERE system_kind LIKE 'auto:genre:%'",
                params![backdated],
            )
            .unwrap();
        }
        db.ensure_auto_playlists(false).unwrap();
        assert!(saved_at(&db) > backdated, "a stale mix must be regenerated");
    }

    // --- MIN_AUTO_PLAYLISTS top-up ---

    fn auto_kinds(db: &Database) -> Vec<String> {
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT system_kind FROM playlists WHERE system_kind LIKE 'auto:%' ORDER BY system_kind")
            .unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
        rows.map(|r| r.unwrap()).collect()
    }

    /// Every mix that exists must carry tracks — the top-up must never ship an
    /// empty card to reach the minimum.
    fn assert_all_non_empty(db: &Database) {
        let conn = db.conn.lock().unwrap();
        let empty: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM playlists p WHERE p.system_kind LIKE 'auto:%' \
                 AND (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = p.id) = 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(empty, 0, "no auto playlist may be empty");
    }

    #[test]
    fn test_ensure_auto_tops_up_to_minimum_single_artist() {
        // One artist, no tags, no years, no history, no likes: the genre/decade/
        // discovery recipes all come back empty and the daily mixes collapse to a
        // single kind, so the top-up has to make up the difference.
        let db = test_db();
        let cid = add_local_collection(&db);
        let artist = db.get_or_create_artist("Solo").unwrap();
        for i in 0..12 {
            mk_track(&db, cid, &format!("s{}.mp3", i), &format!("S{}", i), artist, None, None);
        }
        db.recompute_counts().unwrap();

        db.ensure_auto_playlists(true).unwrap();
        let kinds = auto_kinds(&db);
        assert!(
            kinds.len() >= MIN_AUTO_PLAYLISTS,
            "expected at least {} mixes, got {:?}",
            MIN_AUTO_PLAYLISTS,
            kinds
        );
        assert_all_non_empty(&db);
    }

    #[test]
    fn test_ensure_auto_tops_up_with_samplers_when_nothing_is_seedable() {
        // Tracks with no artist at all: `pick_radio_seeds` yields nothing usable,
        // so only the random samplers can fill the section.
        let db = test_db();
        let cid = add_local_collection(&db);
        for i in 0..6 {
            db.upsert_track(
                &format!("n{}.mp3", i),
                &format!("N{}", i),
                None,
                None,
                None,
                Some(180.0),
                Some("mp3"),
                None,
                None,
                Some(cid),
                None,
            )
            .unwrap();
        }
        db.recompute_counts().unwrap();

        db.ensure_auto_playlists(true).unwrap();
        let kinds = auto_kinds(&db);
        assert_eq!(kinds.len(), MIN_AUTO_PLAYLISTS, "exactly the minimum, all samplers: {:?}", kinds);
        assert!(kinds.iter().all(|k| k.starts_with("auto:sampler:")), "{:?}", kinds);
        assert_all_non_empty(&db);
    }

    #[test]
    fn test_ensure_auto_reuses_fallback_rows_across_runs() {
        let db = test_db();
        let cid = add_local_collection(&db);
        let artist = db.get_or_create_artist("Solo").unwrap();
        for i in 0..8 {
            mk_track(&db, cid, &format!("s{}.mp3", i), &format!("S{}", i), artist, None, None);
        }
        db.recompute_counts().unwrap();

        db.ensure_auto_playlists(true).unwrap();
        let first = auto_kinds(&db);
        // A second (non-forced) run must not churn the cards: the fallback rows
        // are reused, not re-seeded under new names.
        db.ensure_auto_playlists(false).unwrap();
        assert_eq!(first, auto_kinds(&db), "fallback mixes must be stable across runs");
        // And a forced regeneration keeps the same identities too.
        db.ensure_auto_playlists(true).unwrap();
        assert_eq!(first, auto_kinds(&db), "forced refresh must keep the same fallback mixes");
    }

    #[test]
    fn test_ensure_auto_prunes_fallbacks_once_recipes_recover() {
        let db = test_db();
        let cid = add_local_collection(&db);
        let solo = db.get_or_create_artist("Solo").unwrap();
        for i in 0..8 {
            mk_track(&db, cid, &format!("s{}.mp3", i), &format!("S{}", i), solo, None, None);
        }
        db.recompute_counts().unwrap();
        db.ensure_auto_playlists(true).unwrap();
        assert!(
            auto_kinds(&db).iter().any(|k| k.starts_with("auto:seeded:") || k.starts_with("auto:sampler:")),
            "expected fallback mixes on a bare library"
        );

        // Give the library enough material for three real recipe mixes: three
        // tags (genre) plus a populated decade.
        for (i, tag) in ["rock", "jazz", "folk"].iter().enumerate() {
            let tid = db.get_or_create_tag(tag).unwrap();
            for j in 0..14 {
                let id = mk_track(
                    &db,
                    cid,
                    &format!("{}-{}.mp3", tag, j),
                    &format!("{} {}", tag, j),
                    solo,
                    None,
                    Some(1990 + (i as i32)),
                );
                db.add_track_tag(id, tid).unwrap();
            }
        }
        db.recompute_counts().unwrap();
        db.ensure_auto_playlists(true).unwrap();

        let kinds = auto_kinds(&db);
        assert!(kinds.len() >= MIN_AUTO_PLAYLISTS, "{:?}", kinds);
        assert!(
            kinds.iter().all(|k| !k.starts_with("auto:sampler:") && !k.starts_with("auto:seeded:")),
            "fallbacks must be pruned once the recipes fill the minimum: {:?}",
            kinds
        );
    }

    #[test]
    fn test_sampler_mix_falls_back_to_first_slice_on_a_small_library() {
        let db = test_db();
        let cid = add_local_collection(&db);
        let artist = db.get_or_create_artist("A").unwrap();
        for i in 0..3 {
            mk_track(&db, cid, &format!("a{}.mp3", i), &format!("A{}", i), artist, None, None);
        }
        db.recompute_counts().unwrap();

        // Slice 2 starts past the end of a 3-track library — it must still return
        // tracks rather than an empty (and therefore dropped) mix.
        let mix = db.generate_sampler_mix(2, MIX_LEN).unwrap();
        assert_eq!(mix.len(), 3);
    }

    #[test]
    fn test_sampler_mix_excludes_disliked() {
        let db = test_db();
        let cid = add_local_collection(&db);
        let artist = db.get_or_create_artist("A").unwrap();
        let keep = mk_track(&db, cid, "k.mp3", "K", artist, None, None);
        let hated = mk_track(&db, cid, "h.mp3", "H", artist, None, None);
        db.toggle_liked("tracks", hated, -1).unwrap();
        db.recompute_counts().unwrap();

        let mix = db.generate_sampler_mix(0, MIX_LEN).unwrap();
        let ids: std::collections::HashSet<i64> = mix.iter().map(|t| t.id).collect();
        assert!(ids.contains(&keep));
        assert!(!ids.contains(&hated), "disliked track must be excluded");
    }

    #[test]
    fn test_fallback_recipe_from_metadata() {
        match Database::fallback_recipe_from_metadata(
            r#"{"recipe":"seeded","seed_artist":"A","seed_title":"T","first_artist":"A"}"#,
        ) {
            Some(Recipe::SeededFallback { artist, seed_title }) => {
                assert_eq!(artist, "A");
                assert_eq!(seed_title, "T");
            }
            other => panic!("expected a seeded recipe, got {:?}", other.is_some()),
        }
        match Database::fallback_recipe_from_metadata(r#"{"recipe":"sampler","index":2}"#) {
            Some(Recipe::Sampler { index }) => assert_eq!(index, 2),
            other => panic!("expected a sampler recipe, got {:?}", other.is_some()),
        }
        // Unrecognised / malformed rows are not reused (they get pruned instead).
        assert!(Database::fallback_recipe_from_metadata(r#"{"recipe":"genre"}"#).is_none());
        assert!(Database::fallback_recipe_from_metadata("not json").is_none());
        assert!(Database::fallback_recipe_from_metadata(r#"{"recipe":"seeded"}"#).is_none());
    }

    #[test]
    fn test_ensure_auto_prunes_obsolete() {
        let db = test_db();
        let cid = add_local_collection(&db);
        let artist = db.get_or_create_artist("A").unwrap();
        let rock = db.get_or_create_tag("rock").unwrap();
        for i in 0..5 {
            let id = mk_track(&db, cid, &format!("r{}.mp3", i), &format!("R{}", i), artist, None, None);
            db.add_track_tag(id, rock).unwrap();
        }
        db.recompute_counts().unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO playlists (name, system_kind) VALUES ('Old Mix', 'auto:genre:zzz-obsolete')",
                [],
            )
            .unwrap();
        }
        db.ensure_auto_playlists(true).unwrap();

        let conn = db.conn.lock().unwrap();
        let obsolete: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM playlists WHERE system_kind = 'auto:genre:zzz-obsolete'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(obsolete, 0, "obsolete auto playlist should be pruned");
        let rockmix: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM playlists WHERE system_kind = 'auto:genre:rock'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rockmix, 1, "desired rock mix should exist");
    }

    #[test]
    fn test_delete_guard_allows_auto_blocks_protected() {
        let db = test_db();
        db.ensure_system_playlists().unwrap();
        let liked_id: i64 = {
            let conn = db.conn.lock().unwrap();
            conn.query_row("SELECT id FROM playlists WHERE system_kind='liked'", [], |r| r.get(0)).unwrap()
        };
        assert!(db.delete_playlist(liked_id).is_err(), "protected system playlist must not be deletable");

        let auto_id: i64 = {
            let conn = db.conn.lock().unwrap();
            conn.execute("INSERT INTO playlists (name, system_kind) VALUES ('Mix', 'auto:discovery')", []).unwrap();
            conn.last_insert_rowid()
        };
        assert!(db.delete_playlist(auto_id).is_ok(), "auto playlist must be deletable");
        assert_eq!(count_kind_like(&db, "auto:discovery"), 0);
    }

    #[test]
    fn test_get_playlist_tracks_auto_uses_real_rows() {
        let db = test_db();
        let pid: i64 = {
            let conn = db.conn.lock().unwrap();
            conn.execute("INSERT INTO playlists (name, system_kind) VALUES ('Mix', 'auto:genre:test')", []).unwrap();
            let pid = conn.last_insert_rowid();
            conn.execute(
                "INSERT INTO playlist_tracks (playlist_id, position, title, artist_name, source) \
                 VALUES (?1, 0, 'T', 'A', 'file:///x')",
                params![pid],
            )
            .unwrap();
            pid
        };
        // No entity_likes rows exist; without the `auto:` bail this would project empty.
        let tracks = db.get_playlist_tracks(pid).unwrap();
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].title, "T");
        assert_eq!(tracks[0].source.as_deref(), Some("file:///x"));
    }

    #[test]
    fn test_search_playlist_track_ids_matches_tracks_and_likes() {
        let db = test_db();

        // A user playlist with materialized track rows.
        let pid = db.save_playlist("My Mix", None, None, None, None).unwrap();
        db.save_playlist_tracks(pid, &[
            ("Paranoid Android", Some("Radiohead"), Some("OK Computer"), Some(383.0), None, None),
            ("Karma Police", Some("Radiohead"), Some("OK Computer"), Some(261.0), None, None),
        ]).unwrap();

        // An unrelated playlist that must not match the queries below.
        let other = db.save_playlist("Other", None, None, None, None).unwrap();
        db.save_playlist_tracks(other, &[
            ("Blue Monday", Some("New Order"), None, Some(450.0), None, None),
        ]).unwrap();

        // Liked Songs system playlist + a liked track (projected from entity_likes).
        db.ensure_system_playlists().unwrap();
        let liked_pid: i64 = {
            let conn = db.conn.lock().unwrap();
            conn.query_row("SELECT id FROM playlists WHERE system_kind='liked'", [], |r| r.get(0)).unwrap()
        };
        db.set_entity_like(
            "track",
            &build_entity_key("track", "Idioteque", Some("Radiohead")),
            1,
            Some(r#"{"title":"Idioteque","artist_name":"Radiohead"}"#),
            100,
        ).unwrap();

        // Match by artist: hits the materialized user mix AND the liked projection.
        let by_artist: std::collections::HashSet<i64> =
            db.search_playlist_track_ids("radiohead").unwrap().into_iter().collect();
        assert!(by_artist.contains(&pid), "user mix matches by artist");
        assert!(by_artist.contains(&liked_pid), "liked songs matches via entity_likes");
        assert!(!by_artist.contains(&other), "unrelated playlist excluded");

        // Match by track title — case-insensitive substring.
        let by_title: std::collections::HashSet<i64> =
            db.search_playlist_track_ids("KARMA").unwrap().into_iter().collect();
        assert!(by_title.contains(&pid));
        assert!(!by_title.contains(&liked_pid));

        // No match / blank query → empty.
        assert!(db.search_playlist_track_ids("nonexistent zzz").unwrap().is_empty());
        assert!(db.search_playlist_track_ids("   ").unwrap().is_empty());
    }
}
