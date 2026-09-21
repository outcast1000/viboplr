// Auto-split from db.rs. Shared types/helpers live in db/mod.rs;
// these are inherent `impl Database` methods reachable via `use super::*`.
use super::*;
use std::collections::{HashMap, HashSet};
use crate::db::likes::norm_segment;

// The audio/video SQL clauses (VIDEO_FORMAT_CLAUSE / AUDIO_FORMAT_CLAUSE /
// media_type_clause) live in db/mod.rs, shared by every surface that splits
// audio from video; the pinning test stays below.

/// Radio-seed pools (see `pick_radio_seeds`). A row of `count` seeds is split
/// into a **familiar** quota (liked, or played within the window) and a
/// **discovery** quota (never played, not liked), each drawn as a weighted
/// sample from its own pool. Quotas, not a single proportional sample, because
/// a proportional draw tracks the library's shape: a large library is mostly
/// tracks the user never touched, so most seeds were strangers, however high
/// the favourite weights went.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum RadioSeedPool {
    /// Liked, or played in the last `RADIO_SEED_WINDOW_DAYS`. Weight:
    /// `LIKED × (1 + PER_PLAY × min(plays, CAP))`, so a liked track with many
    /// recent plays is 9× as likely as a track merely played once.
    Familiar,
    /// Never played and not liked. Weight: `1 + ARTIST_PER_PLAY × min(artist
    /// plays in the window, ARTIST_PLAY_CAP) + ARTIST_PER_LIKE × min(artist's
    /// liked tracks, ARTIST_LIKE_CAP)` — an unheard song by an artist the user
    /// plays and likes is up to 11× as likely as one by a stranger. Discovery,
    /// but anchored to taste rather than uniform over the long tail.
    Discovery,
}

/// Play-history window for both pools, in days. 30 read a favourite from two
/// months ago as untouched.
const RADIO_SEED_WINDOW_DAYS: i64 = 90;
const RADIO_SEED_LIKED_WEIGHT: f64 = 3.0;
const RADIO_SEED_PER_PLAY_WEIGHT: f64 = 0.5;
const RADIO_SEED_PLAY_CAP: u32 = 4;
const RADIO_SEED_ARTIST_PER_PLAY_WEIGHT: f64 = 0.25;
const RADIO_SEED_ARTIST_PLAY_CAP: u32 = 20;
const RADIO_SEED_ARTIST_PER_LIKE_WEIGHT: f64 = 1.0;
const RADIO_SEED_ARTIST_LIKE_CAP: u32 = 5;

/// Split a row of `count` seeds into (familiar, discovery) quotas: half each,
/// the odd one going to familiar.
pub(super) fn radio_seed_quotas(count: u32) -> (u32, u32) {
    let discovery = count / 2;
    (count - discovery, discovery)
}

/// True when a `tracks.format` value names a video container.
fn is_video_format(format: Option<&str>) -> bool {
    format
        .map(|f| crate::scanner::VIDEO_EXTENSIONS.contains(&f.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// The batched history album lookup, parameterized by how many normalized
/// titles are in the IN list. Built by a function rather than inlined so the
/// query-plan test can assert against the SQL that actually runs: the WHERE
/// expression must stay character-identical to `idx_tracks_title_norm`'s, or
/// SQLite silently falls back to a full scan.
fn history_album_sql(title_count: usize) -> String {
    let placeholders = std::iter::repeat("?").take(title_count).collect::<Vec<_>>().join(",");
    format!(
        "SELECT strip_diacritics(unicode_lower(t.title)), \
                strip_diacritics(unicode_lower(ar.name)), \
                al.title, alar.name, \
                CASE WHEN co.kind = 'local' THEN 0 WHEN co.kind = 'subsonic' THEN 1 ELSE 2 END, \
                al.id \
           FROM tracks t \
           JOIN artists ar ON t.artist_id = ar.id \
           JOIN albums al ON t.album_id = al.id \
           LEFT JOIN artists alar ON al.artist_id = alar.id \
           LEFT JOIN collections co ON t.collection_id = co.id \
          WHERE strip_diacritics(unicode_lower(t.title)) IN ({placeholders}) \
            AND (t.collection_id IS NULL OR co.enabled = 1)"
    )
}

/// Resolve a library album — and the album's own album artist — for a batch of
/// history rows, keyed by normalized (title, artist).
///
/// History stores no album, yet every surface that renders a history row wants
/// the album *cover*, and album art is keyed by album title + album artist (see
/// CLAUDE.md -> "Album identity"): on a compilation the play's own artist is the
/// performer and keys nothing. So both come back together, or neither.
///
/// The batch is looked up through the `idx_tracks_title_norm` expression index
/// with a single IN-list query, making this O(rows) index seeks. That is the
/// whole reason album resolution is affordable on every history query now: the
/// first version ran a correlated subquery per row (O(rows x tracks)) and froze
/// the History view for seconds, and its replacement scanned + normalized the
/// entire library once per call, which was cheap enough for one Home shelf but
/// not for a per-keystroke search.
///
/// Preference on multiple matches: local > subsonic > other, newest album
/// (highest id) breaking ties — the same order as `find_tracks_by_metadata`.
fn resolve_history_albums(
    conn: &Connection,
    keys: &[(String, String)],
) -> SqlResult<HashMap<(String, String), (String, Option<String>)>> {
    let mut out: HashMap<(String, String), (String, Option<String>)> = HashMap::new();
    if keys.is_empty() {
        return Ok(out);
    }
    let wanted: HashSet<&(String, String)> = keys.iter().collect();
    let mut titles: Vec<&str> = keys.iter().map(|(t, _)| t.as_str()).collect();
    titles.sort_unstable();
    titles.dedup();

    // Best match so far per key, carrying (priority, album id) for the tie-break.
    let mut best: HashMap<(String, String), (i64, i64)> = HashMap::new();

    // Chunked to stay well under SQLite's bound-parameter limit.
    for chunk in titles.chunks(200) {
        let mut stmt = conn.prepare(&history_album_sql(chunk.len()))?;
        let rows = stmt.query_map(rusqlite::params_from_iter(chunk.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })?;
        for row in rows {
            let (norm_title, norm_artist, album, album_artist, prio, album_id) = row?;
            let key = (norm_title, norm_artist);
            // The IN list matches on title alone, so most rows here belong to a
            // different artist's same-titled track.
            if !wanted.contains(&key) {
                continue;
            }
            let replace = match best.get(&key) {
                None => true,
                Some(&(cur_prio, cur_aid)) => prio < cur_prio || (prio == cur_prio && album_id > cur_aid),
            };
            if replace {
                best.insert(key.clone(), (prio, album_id));
                out.insert(key, (album, album_artist));
            }
        }
    }
    Ok(out)
}

/// Fill in `display_album` / `display_album_artist` on a batch of most-played
/// or searched history tracks. Wraps `resolve_history_albums` so the three
/// queries returning `HistoryMostPlayed` stamp albums identically — the History
/// view's Tracks tab, its search results and the Home "Most played" shelves all
/// render art from these fields.
fn stamp_history_albums(conn: &Connection, tracks: &mut [HistoryMostPlayed]) -> SqlResult<()> {
    if tracks.is_empty() {
        return Ok(());
    }
    let keys: Vec<(String, String)> = tracks
        .iter()
        .map(|t| (norm_segment(Some(&t.display_title)), norm_segment(t.display_artist.as_deref())))
        .collect();
    let albums = resolve_history_albums(conn, &keys)?;
    for (t, key) in tracks.iter_mut().zip(keys) {
        if let Some((album, album_artist)) = albums.get(&key) {
            t.display_album = Some(album.clone());
            t.display_album_artist = album_artist.clone();
        }
    }
    Ok(())
}

impl Database {

    // --- Play history ---

    #[cfg(test)]
    pub fn record_play(&self, track_id: i64) -> SqlResult<()> {
        self.record_history_play(track_id)
    }

    pub fn get_auto_continue_track(&self, strategy: &str, current_title: &str, current_artist: Option<&str>, format_filter: Option<&str>, exclude_ids: &[i64]) -> SqlResult<Option<Track>> {
        let conn = self.conn.lock().unwrap();

        let format_clause = media_type_clause(format_filter);

        let dislike_clause = " AND t.liked != -1";

        let exclude_clause = if exclude_ids.is_empty() {
            String::new()
        } else {
            let ids: Vec<String> = exclude_ids.iter().map(|id| id.to_string()).collect();
            format!(" AND t.id NOT IN ({})", ids.join(","))
        };

        let canonical_title = strip_diacritics(&current_title.to_lowercase());
        let exclude_self = " AND strip_diacritics(unicode_lower(t.title)) != ?1";

        match strategy {
            "random" => {
                let sql = format!("{} WHERE 1=1 {}{}{}{}{} ORDER BY RANDOM() LIMIT 1", TRACK_SELECT, exclude_self, ENABLED_COLLECTION_FILTER, format_clause, dislike_clause, exclude_clause);
                conn.query_row(&sql, params![canonical_title], |row| track_from_row(row)).optional()
            }
            "same_artist" => {
                let artist = current_artist.unwrap_or("");
                let canonical_artist = strip_diacritics(&artist.to_lowercase());
                let artist_id: Option<i64> = conn.query_row(
                    "SELECT id FROM artists WHERE strip_diacritics(unicode_lower(name)) = ?1",
                    params![canonical_artist],
                    |row| row.get(0),
                ).optional()?;
                match artist_id {
                    Some(aid) => {
                        let sql = format!("{} WHERE t.artist_id = ?2 {}{}{}{}{} ORDER BY RANDOM() LIMIT 1", TRACK_SELECT, exclude_self, ENABLED_COLLECTION_FILTER, format_clause, dislike_clause, exclude_clause);
                        conn.query_row(&sql, params![canonical_title, aid], |row| track_from_row(row)).optional()
                    }
                    None => Ok(None),
                }
            }
            "same_tag" => {
                let artist = current_artist.unwrap_or("");
                let canonical_artist = strip_diacritics(&artist.to_lowercase());
                let track_id: Option<i64> = conn.query_row(
                    "SELECT t.id FROM tracks t \
                     LEFT JOIN artists ar ON t.artist_id = ar.id \
                     WHERE strip_diacritics(unicode_lower(t.title)) = ?1 \
                     AND strip_diacritics(unicode_lower(COALESCE(ar.name, ''))) = ?2 \
                     LIMIT 1",
                    params![canonical_title, canonical_artist],
                    |row| row.get(0),
                ).optional()?;
                match track_id {
                    Some(tid) => {
                        let sql = format!(
                            "{} WHERE t.id != ?1 {}{}{}{} AND t.id IN (\
                                SELECT tt2.track_id FROM track_tags tt1 \
                                JOIN track_tags tt2 ON tt1.tag_id = tt2.tag_id \
                                WHERE tt1.track_id = ?1 AND tt2.track_id != ?1\
                            ) ORDER BY RANDOM() LIMIT 1",
                            TRACK_SELECT, ENABLED_COLLECTION_FILTER, format_clause, dislike_clause, exclude_clause
                        );
                        conn.query_row(&sql, params![tid], |row| track_from_row(row)).optional()
                    }
                    None => Ok(None),
                }
            }
            "most_played" => {
                let sql = format!(
                    "{} WHERE 1=1 {}{}{}{}{} AND t.id IN (\
                        SELECT t2.id FROM tracks t2 \
                        LEFT JOIN artists ar2 ON t2.artist_id = ar2.id \
                        JOIN history_tracks ht ON ht.canonical_title = strip_diacritics(unicode_lower(t2.title)) \
                        JOIN history_artists ha ON ha.id = ht.history_artist_id \
                            AND ha.canonical_name = strip_diacritics(unicode_lower(COALESCE(ar2.name, ''))) \
                        WHERE ht.play_count > 0 \
                        ORDER BY ht.play_count DESC LIMIT 50\
                    ) ORDER BY RANDOM() LIMIT 1",
                    TRACK_SELECT, exclude_self, ENABLED_COLLECTION_FILTER, format_clause, dislike_clause, exclude_clause
                );
                conn.query_row(&sql, params![canonical_title], |row| track_from_row(row)).optional()
            }
            "liked" => {
                let sql = format!("{} WHERE t.liked = 1 {}{}{}{} ORDER BY RANDOM() LIMIT 1", TRACK_SELECT, exclude_self, ENABLED_COLLECTION_FILTER, format_clause, exclude_clause);
                conn.query_row(&sql, params![canonical_title], |row| track_from_row(row)).optional()
            }
            _ => Ok(None),
        }
    }

    pub fn build_radio_for_track(
        &self,
        seed_title: &str,
        seed_artist: Option<&str>,
        target_count: u32,
    ) -> SqlResult<Vec<Track>> {
        if target_count == 0 {
            return Ok(Vec::new());
        }

        let canonical_title = strip_diacritics(&seed_title.to_lowercase());
        let canonical_artist = strip_diacritics(&seed_artist.unwrap_or("").to_lowercase());

        // Resolve seed and the artist's full tag set in one connection scope.
        let (seed, tag_pool): (Track, Vec<i64>) = {
            let conn = self.conn.lock().unwrap();
            let sql = format!(
                "{} WHERE strip_diacritics(unicode_lower(t.title)) = ?1 \
                 AND strip_diacritics(unicode_lower(COALESCE(ar.name, ''))) = ?2 \
                 {} LIMIT 1",
                TRACK_SELECT, ENABLED_COLLECTION_FILTER
            );
            let seed: Option<Track> = conn.query_row(&sql, params![canonical_title, canonical_artist], |row| track_from_row(row)).optional()?;
            let seed = match seed {
                Some(t) => t,
                None => return Ok(Vec::new()),
            };
            // Aggregate all tags ever applied to any track by this artist (not just the seed track).
            // Falls through to artist-only picks if the artist has no tags.
            let pool: Vec<i64> = if let Some(aid) = seed.artist_id {
                let mut stmt = conn.prepare(
                    "SELECT DISTINCT tt.tag_id FROM track_tags tt \
                     JOIN tracks t2 ON tt.track_id = t2.id \
                     WHERE t2.artist_id = ?1"
                )?;
                let rows = stmt.query_map(params![aid], |row| row.get::<_, i64>(0))?;
                rows.collect::<SqlResult<Vec<_>>>()?
            } else {
                Vec::new()
            };
            (seed, pool)
        };

        // Keep the station coherent with the seed's media type — mirror
        // auto-continue's same-format behavior so an audio seed never queues
        // video tracks (and a video seed never queues audio).
        let format_clause = if is_video_format(seed.format.as_deref()) {
            VIDEO_FORMAT_CLAUSE.as_str()
        } else {
            AUDIO_FORMAT_CLAUSE.as_str()
        };

        let mut result: Vec<Track> = vec![seed.clone()];
        let mut excluded: Vec<i64> = vec![seed.id];
        let mut stalls = 0u32;

        while (result.len() as u32) < target_count {
            let coin: i64 = {
                let conn = self.conn.lock().unwrap();
                conn.query_row("SELECT ABS(RANDOM()) % 2", [], |row| row.get(0))?
            };
            let prefer_tag_first = coin == 1;

            let try_artist = || self.pick_same_artist_radio(&seed, format_clause, &excluded);
            let try_tag = || self.pick_same_tag_pool_radio(&seed, &tag_pool, format_clause, &excluded);

            let pick = if prefer_tag_first {
                match try_tag()? {
                    Some(t) => Some(t),
                    None => try_artist()?,
                }
            } else {
                match try_artist()? {
                    Some(t) => Some(t),
                    None => try_tag()?,
                }
            };

            match pick {
                Some(t) => {
                    excluded.push(t.id);
                    result.push(t);
                    stalls = 0;
                }
                None => {
                    stalls += 1;
                    if stalls >= 4 { break; }
                }
            }
        }

        Ok(result)
    }

    fn pick_same_artist_radio(&self, seed: &Track, format_clause: &str, excluded: &[i64]) -> SqlResult<Option<Track>> {
        let aid = match seed.artist_id {
            Some(id) => id,
            None => return Ok(None),
        };
        let conn = self.conn.lock().unwrap();
        let exclude_clause = if excluded.is_empty() {
            String::new()
        } else {
            let ids: Vec<String> = excluded.iter().map(|id| id.to_string()).collect();
            format!(" AND t.id NOT IN ({})", ids.join(","))
        };
        let sql = format!(
            "{} WHERE t.artist_id = ?1 AND t.liked != -1 {}{}{} ORDER BY RANDOM() LIMIT 1",
            TRACK_SELECT, ENABLED_COLLECTION_FILTER, format_clause, exclude_clause
        );
        conn.query_row(&sql, params![aid], |row| track_from_row(row)).optional()
    }

    fn pick_same_tag_pool_radio(&self, _seed: &Track, tag_pool: &[i64], format_clause: &str, excluded: &[i64]) -> SqlResult<Option<Track>> {
        if tag_pool.is_empty() {
            return Ok(None);
        }
        let conn = self.conn.lock().unwrap();
        let tag_list: Vec<String> = tag_pool.iter().map(|id| id.to_string()).collect();
        let exclude_clause = if excluded.is_empty() {
            String::new()
        } else {
            let ids: Vec<String> = excluded.iter().map(|id| id.to_string()).collect();
            format!(" AND t.id NOT IN ({})", ids.join(","))
        };
        let sql = format!(
            "{} WHERE t.liked != -1 {}{}{} AND t.id IN (\
                SELECT DISTINCT track_id FROM track_tags WHERE tag_id IN ({})\
            ) ORDER BY RANDOM() LIMIT 1",
            TRACK_SELECT, ENABLED_COLLECTION_FILTER, format_clause, exclude_clause, tag_list.join(",")
        );
        conn.query_row(&sql, [], |row| track_from_row(row)).optional()
    }

    /// Pick `count` radio-station seeds: a familiar quota and a discovery quota
    /// (`radio_seed_quotas`), each a weighted sample from its pool
    /// (`RadioSeedPool`), one track per artist across the whole row, and the
    /// two interleaved so a carousel alternates known and new. `exclude` is the
    /// carousel's shown-seed cooldown. When a pool can't fill its quota the
    /// other tops the row up, then the artist-distinct rule is relaxed, and
    /// only then is the cooldown dropped — so a small library still fills the
    /// row rather than thinning it.
    pub fn pick_radio_seeds(&self, count: u32, exclude: &[i64]) -> SqlResult<Vec<Track>> {
        if count == 0 {
            return Ok(Vec::new());
        }

        let conn = self.conn.lock().unwrap();
        let now_ts: i64 = conn.query_row("SELECT strftime('%s', 'now')", [], |row| {
            let s: String = row.get(0)?;
            Ok(s.parse::<i64>().unwrap_or(0))
        })?;
        let cutoff = now_ts - RADIO_SEED_WINDOW_DAYS * 24 * 60 * 60;
        let overfetch = (count as i64) * 4;
        let (familiar_quota, discovery_quota) = radio_seed_quotas(count);
        let pools = [
            (RadioSeedPool::Familiar, familiar_quota),
            (RadioSeedPool::Discovery, discovery_quota),
        ];

        let mut familiar: Vec<Track> = Vec::with_capacity(familiar_quota as usize);
        let mut discovery: Vec<Track> = Vec::with_capacity(discovery_quota as usize);
        let mut seen_artists: HashSet<i64> = HashSet::new();
        let total = |f: &Vec<Track>, d: &Vec<Track>| (f.len() + d.len()) as u32;

        // Pass 1 honours the cooldown; pass 2 (only if the row is still short)
        // drops it, skipping what pass 1 already picked.
        for pass in 0..2 {
            if total(&familiar, &discovery) >= count { break; }
            if pass == 1 && exclude.is_empty() { break; }
            let mut skip: Vec<i64> = if pass == 0 { exclude.to_vec() } else { Vec::new() };
            skip.extend(familiar.iter().chain(discovery.iter()).map(|t| t.id));

            let candidates: Vec<(RadioSeedPool, Vec<Track>)> = pools
                .iter()
                .map(|(pool, _)| Ok((*pool, Self::radio_seed_candidates(&conn, *pool, cutoff, overfetch, &skip)?)))
                .collect::<SqlResult<_>>()?;

            // Round 1: each pool fills its own quota, artist-distinct.
            for ((pool, quota), (_, cands)) in pools.iter().zip(&candidates) {
                let bucket = if *pool == RadioSeedPool::Familiar { &mut familiar } else { &mut discovery };
                Self::take_seeds(bucket, *quota, cands, &mut seen_artists, true);
            }
            // Round 2: a pool that fell short is topped up from the other,
            // still artist-distinct. Round 3: relax the distinct rule.
            for distinct in [true, false] {
                for (pool, cands) in &candidates {
                    let room = count.saturating_sub(total(&familiar, &discovery));
                    if room == 0 { break; }
                    let bucket = if *pool == RadioSeedPool::Familiar { &mut familiar } else { &mut discovery };
                    let target = bucket.len() as u32 + room;
                    Self::take_seeds(bucket, target, cands, &mut seen_artists, distinct);
                }
            }
        }

        // Interleave familiar and discovery, familiar first, so the carousel
        // alternates a known station and a new one rather than front-loading
        // either half.
        let mut out: Vec<Track> = Vec::with_capacity(count as usize);
        let mut f = familiar.into_iter();
        let mut d = discovery.into_iter();
        loop {
            match (f.next(), d.next()) {
                (None, None) => break,
                (a, b) => {
                    out.extend(a);
                    out.extend(b);
                }
            }
        }
        Ok(out)
    }

    /// Append candidates to `bucket` until it holds `target` tracks, skipping
    /// ids already in it and — when `distinct` — artists already seen anywhere
    /// in the row. Candidates come pre-sorted by the weighted sample, so taking
    /// them in order preserves the draw.
    fn take_seeds(bucket: &mut Vec<Track>, target: u32, candidates: &[Track], seen_artists: &mut HashSet<i64>, distinct: bool) {
        let have: HashSet<i64> = bucket.iter().map(|t| t.id).collect();
        for t in candidates {
            if (bucket.len() as u32) >= target { break; }
            if have.contains(&t.id) { continue; }
            match t.artist_id {
                Some(aid) if distinct => {
                    if !seen_artists.insert(aid) { continue; }
                }
                Some(aid) => { seen_artists.insert(aid); }
                None => {}
            }
            bucket.push(t.clone());
        }
    }

    /// A weighted sample of up to `limit` tracks from one seed pool, best key
    /// first, never a disliked track, never an id in `skip`. Plays are counted
    /// from `history_plays` rows within the window, not from the denormalised
    /// `play_count` columns (the batch import leaves those at 0).
    pub(super) fn radio_seed_candidates(conn: &Connection, pool: RadioSeedPool, cutoff: i64, limit: i64, skip: &[i64]) -> SqlResult<Vec<Track>> {
        let exclude_clause = if skip.is_empty() {
            String::new()
        } else {
            let ids: Vec<String> = skip.iter().map(|id| id.to_string()).collect();
            format!(" AND t.id NOT IN ({})", ids.join(","))
        };
        // Per-track plays in the window: the track's history row joined to its
        // plays. Shared by both pools (Familiar weights by it, Discovery
        // requires it to be zero).
        let track_plays = "\
             LEFT JOIN history_artists ha ON ha.canonical_name = strip_diacritics(unicode_lower(COALESCE(ar.name, ''))) \
             LEFT JOIN history_tracks ht ON ht.history_artist_id = ha.id \
                  AND ht.canonical_title = strip_diacritics(unicode_lower(t.title)) \
             LEFT JOIN history_plays hp ON hp.history_track_id = ht.id AND hp.played_at >= ?1 ";
        let sql = match pool {
            RadioSeedPool::Familiar => format!(
                "{select} {track_plays} \
                 WHERE t.liked != -1 {enabled}{exclude} \
                 GROUP BY t.id \
                 HAVING t.liked = 1 OR COUNT(hp.id) > 0 \
                 ORDER BY weighted_sample_key(RANDOM(), \
                     (CASE WHEN t.liked = 1 THEN {liked} ELSE 1.0 END) * \
                     (1.0 + {per_play} * MIN(COUNT(hp.id), {play_cap})) \
                 ) ASC \
                 LIMIT ?2",
                select = TRACK_SELECT, track_plays = track_plays,
                enabled = ENABLED_COLLECTION_FILTER, exclude = exclude_clause,
                liked = RADIO_SEED_LIKED_WEIGHT,
                per_play = RADIO_SEED_PER_PLAY_WEIGHT,
                play_cap = RADIO_SEED_PLAY_CAP,
            ),
            // Artist affinity is aggregated once per artist in the CTEs rather
            // than as correlated subqueries, which would re-count for every
            // candidate row.
            RadioSeedPool::Discovery => format!(
                "WITH artist_plays AS ( \
                     SELECT ht2.history_artist_id AS ha_id, COUNT(*) AS n \
                     FROM history_plays hp2 \
                     JOIN history_tracks ht2 ON ht2.id = hp2.history_track_id \
                     WHERE hp2.played_at >= ?1 \
                     GROUP BY ht2.history_artist_id \
                 ), artist_likes AS ( \
                     SELECT artist_id, COUNT(*) AS n FROM tracks WHERE liked = 1 AND artist_id IS NOT NULL GROUP BY artist_id \
                 ) \
                 {select} {track_plays} \
                 LEFT JOIN artist_plays ap ON ap.ha_id = ha.id \
                 LEFT JOIN artist_likes alk ON alk.artist_id = t.artist_id \
                 WHERE t.liked = 0 {enabled}{exclude} \
                 GROUP BY t.id \
                 HAVING COUNT(hp.id) = 0 \
                 ORDER BY weighted_sample_key(RANDOM(), \
                     1.0 + {per_artist_play} * MIN(COALESCE(MAX(ap.n), 0), {artist_play_cap}) \
                         + {per_artist_like} * MIN(COALESCE(MAX(alk.n), 0), {artist_like_cap}) \
                 ) ASC \
                 LIMIT ?2",
                select = TRACK_SELECT, track_plays = track_plays,
                enabled = ENABLED_COLLECTION_FILTER, exclude = exclude_clause,
                per_artist_play = RADIO_SEED_ARTIST_PER_PLAY_WEIGHT,
                artist_play_cap = RADIO_SEED_ARTIST_PLAY_CAP,
                per_artist_like = RADIO_SEED_ARTIST_PER_LIKE_WEIGHT,
                artist_like_cap = RADIO_SEED_ARTIST_LIKE_CAP,
            ),
        };
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![cutoff, limit], |row| track_from_row(row))?;
        rows.collect()
    }

    /// Library tracks that have never been played (no matching history play),
    /// randomly sampled. History is name-based, so a track counts as played only
    /// when a history_track for its canonical artist+title has plays.
    pub fn pick_never_played_tracks(&self, limit: u32) -> SqlResult<Vec<Track>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "{} \
             LEFT JOIN history_artists ha ON ha.canonical_name = strip_diacritics(unicode_lower(COALESCE(ar.name, ''))) \
             LEFT JOIN history_tracks ht ON ht.history_artist_id = ha.id \
                  AND ht.canonical_title = strip_diacritics(unicode_lower(t.title)) \
             LEFT JOIN history_plays hp ON hp.history_track_id = ht.id \
             WHERE 1=1 {} \
             GROUP BY t.id \
             HAVING COUNT(hp.id) = 0 \
             ORDER BY RANDOM() \
             LIMIT ?1",
            TRACK_SELECT, ENABLED_COLLECTION_FILTER
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![limit], |row| track_from_row(row))?;
        rows.collect()
    }

    /// Tracks played repeatedly in the past but not heard in the last 30 days,
    /// ranked by total play count — the Home "Forgotten favorites" shelf.
    pub fn pick_forgotten_favorites(&self, limit: u32) -> SqlResult<Vec<Track>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().unwrap();
        let now_ts: i64 = conn.query_row("SELECT strftime('%s', 'now')", [], |row| {
            let s: String = row.get(0)?;
            Ok(s.parse::<i64>().unwrap_or(0))
        })?;
        let cutoff = now_ts - 30 * 24 * 60 * 60;
        let sql = format!(
            "{} \
             LEFT JOIN history_artists ha ON ha.canonical_name = strip_diacritics(unicode_lower(COALESCE(ar.name, ''))) \
             LEFT JOIN history_tracks ht ON ht.history_artist_id = ha.id \
                  AND ht.canonical_title = strip_diacritics(unicode_lower(t.title)) \
             LEFT JOIN history_plays hp ON hp.history_track_id = ht.id \
             WHERE 1=1 {} \
             GROUP BY t.id \
             HAVING COUNT(hp.id) >= 2 AND MAX(hp.played_at) < ?1 \
             ORDER BY COUNT(hp.id) DESC \
             LIMIT ?2",
            TRACK_SELECT, ENABLED_COLLECTION_FILTER
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![cutoff, limit], |row| track_from_row(row))?;
        rows.collect()
    }

    // --- Decoupled history ---

    /// Upsert the history_artist and history_track rows, insert a play (gated
    /// by the 30-second dedup window), and bump the denormalized counters.
    /// Shared by the library-track-id path and the metadata-only (plugin / non-
    /// library) path so the dedup and count-update logic never drifts.
    fn record_history_play_inner(
        conn: &rusqlite::Connection,
        display_title: &str,
        display_artist: Option<&str>,
        canonical_title: &str,
        canonical_artist: &str,
    ) -> SqlResult<()> {
        conn.execute(
            "INSERT INTO history_artists (canonical_name, display_name, first_played_at, last_played_at, play_count)
             VALUES (?1, ?2, strftime('%s', 'now'), strftime('%s', 'now'), 0)
             ON CONFLICT(canonical_name) DO UPDATE SET
               display_name = excluded.display_name",
            params![canonical_artist, display_artist],
        )?;
        let history_artist_id: i64 = conn.query_row(
            "SELECT id FROM history_artists WHERE canonical_name = ?1",
            params![canonical_artist],
            |row| row.get(0),
        )?;

        conn.execute(
            "INSERT INTO history_tracks (history_artist_id, canonical_title, display_title, first_played_at, last_played_at, play_count)
             VALUES (?1, ?2, ?3, strftime('%s', 'now'), strftime('%s', 'now'), 0)
             ON CONFLICT(history_artist_id, canonical_title) DO UPDATE SET
               display_title = excluded.display_title",
            params![history_artist_id, canonical_title, display_title],
        )?;
        let history_track_id: i64 = conn.query_row(
            "SELECT id FROM history_tracks WHERE history_artist_id = ?1 AND canonical_title = ?2",
            params![history_artist_id, canonical_title],
            |row| row.get(0),
        )?;

        // Dedup: skip play record + count update if same track played within 30 seconds
        let dominated: bool = conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM history_plays hp
                WHERE hp.history_track_id = ?1
                AND hp.played_at > strftime('%s', 'now') - 30
            )",
            params![history_track_id],
            |row| row.get(0),
        )?;
        if dominated {
            return Ok(());
        }

        // Insert play record
        conn.execute(
            "INSERT INTO history_plays (history_track_id) VALUES (?1)",
            params![history_track_id],
        )?;

        // Update denormalized counts
        conn.execute(
            "UPDATE history_tracks SET play_count = play_count + 1, last_played_at = strftime('%s', 'now') WHERE id = ?1",
            params![history_track_id],
        )?;
        conn.execute(
            "UPDATE history_artists SET play_count = play_count + 1, last_played_at = strftime('%s', 'now') WHERE id = ?1",
            params![history_artist_id],
        )?;

        Ok(())
    }

    #[cfg(test)]
    pub fn record_history_play(&self, track_id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        let (title, artist_name): (String, Option<String>) = conn.query_row(
            "SELECT t.title, ar.name FROM tracks t
             LEFT JOIN artists ar ON t.artist_id = ar.id
             WHERE t.id = ?1",
            params![track_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        let canonical_artist = strip_diacritics(&artist_name.as_deref().unwrap_or("").to_lowercase());
        let canonical_title = strip_diacritics(&title.to_lowercase());

        Self::record_history_play_inner(
            &conn,
            &title,
            artist_name.as_deref(),
            &canonical_title,
            &canonical_artist,
        )
    }

    pub fn record_play_by_metadata(&self, title: &str, artist_name: Option<&str>) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        let artist = artist_name.unwrap_or("");
        let canonical_artist = strip_diacritics(&artist.to_lowercase());
        let canonical_title = strip_diacritics(&title.to_lowercase());

        Self::record_history_play_inner(&conn, title, Some(artist), &canonical_title, &canonical_artist)
    }

    /// Batch-insert history plays from Last.fm import.
    /// Each entry is (artist_name, track_title, played_at_unix).
    /// Returns (imported, skipped) counts.
    pub fn record_history_plays_batch(&self, plays: &[(String, String, i64)]) -> SqlResult<(u64, u64)> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let mut imported: u64 = 0;
        let mut skipped: u64 = 0;

        for (artist_name, track_title, played_at) in plays {
            let canonical_artist = strip_diacritics(&artist_name.to_lowercase());
            let canonical_title = strip_diacritics(&track_title.to_lowercase());

            // Upsert history_artists with MIN/MAX for timestamps
            tx.execute(
                "INSERT INTO history_artists (canonical_name, display_name, first_played_at, last_played_at, play_count)
                 VALUES (?1, ?2, ?3, ?3, 0)
                 ON CONFLICT(canonical_name) DO UPDATE SET
                   first_played_at = MIN(history_artists.first_played_at, excluded.first_played_at),
                   last_played_at = MAX(history_artists.last_played_at, excluded.last_played_at)",
                params![canonical_artist, artist_name, played_at],
            )?;
            let history_artist_id: i64 = tx.query_row(
                "SELECT id FROM history_artists WHERE canonical_name = ?1",
                params![canonical_artist],
                |row| row.get(0),
            )?;

            // Upsert history_tracks with MIN/MAX for timestamps
            tx.execute(
                "INSERT INTO history_tracks (history_artist_id, canonical_title, display_title, first_played_at, last_played_at, play_count)
                 VALUES (?1, ?2, ?3, ?4, ?4, 0)
                 ON CONFLICT(history_artist_id, canonical_title) DO UPDATE SET
                   first_played_at = MIN(history_tracks.first_played_at, excluded.first_played_at),
                   last_played_at = MAX(history_tracks.last_played_at, excluded.last_played_at)",
                params![history_artist_id, canonical_title, track_title, played_at],
            )?;
            let history_track_id: i64 = tx.query_row(
                "SELECT id FROM history_tracks WHERE history_artist_id = ?1 AND canonical_title = ?2",
                params![history_artist_id, canonical_title],
                |row| row.get(0),
            )?;

            // Exact-timestamp dedup: skip if this exact play already exists
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM history_plays WHERE history_track_id = ?1 AND played_at = ?2)",
                params![history_track_id, played_at],
                |row| row.get(0),
            )?;
            if exists {
                skipped += 1;
                continue;
            }

            // Insert play record with explicit timestamp
            tx.execute(
                "INSERT INTO history_plays (history_track_id, played_at) VALUES (?1, ?2)",
                params![history_track_id, played_at],
            )?;

            // Update denormalized counts
            tx.execute(
                "UPDATE history_tracks SET play_count = play_count + 1, last_played_at = MAX(last_played_at, ?2) WHERE id = ?1",
                params![history_track_id, played_at],
            )?;
            tx.execute(
                "UPDATE history_artists SET play_count = play_count + 1, last_played_at = MAX(last_played_at, ?2) WHERE id = ?1",
                params![history_artist_id, played_at],
            )?;

            imported += 1;
        }

        tx.commit()?;
        Ok((imported, skipped))
    }

    pub fn get_history_recent(&self, limit: i64) -> SqlResult<Vec<HistoryEntry>> {
        let conn = self.conn.lock().unwrap();
        // Recent plays come straight off the played_at index — no per-row work.
        // The album is resolved afterwards in one batched, indexed lookup (see
        // resolve_history_albums), which is why there is no longer a
        // resolve_albums opt-out: every caller renders an album cover, and the
        // resolution no longer costs a library scan.
        let mut stmt = conn.prepare(
            "SELECT hp.id, ht.id, hp.played_at, ht.display_title, ha.display_name, ht.play_count
             FROM history_plays hp
             JOIN history_tracks ht ON ht.id = hp.history_track_id
             JOIN history_artists ha ON ha.id = ht.history_artist_id
             ORDER BY hp.played_at DESC
             LIMIT ?1"
        )?;
        let mut entries: Vec<HistoryEntry> = stmt
            .query_map(params![limit], |row| {
                Ok(HistoryEntry {
                    id: row.get(0)?,
                    history_track_id: row.get(1)?,
                    played_at: row.get(2)?,
                    display_title: row.get(3)?,
                    display_artist: row.get(4)?,
                    play_count: row.get(5)?,
                    display_album: None,
                    display_album_artist: None,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        if !entries.is_empty() {
            let keys: Vec<(String, String)> = entries
                .iter()
                .map(|e| (norm_segment(Some(&e.display_title)), norm_segment(e.display_artist.as_deref())))
                .collect();
            let albums = resolve_history_albums(&conn, &keys)?;
            for (e, key) in entries.iter_mut().zip(keys) {
                if let Some((album, album_artist)) = albums.get(&key) {
                    e.display_album = Some(album.clone());
                    e.display_album_artist = album_artist.clone();
                }
            }
        }
        Ok(entries)
    }

    /// Total number of recorded plays. Cheap (`COUNT(*)` over an indexed table);
    /// used by the chunked history streamer to drive a determinate progress bar.
    pub fn get_history_play_count(&self) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM history_plays", [], |row| row.get(0))
    }

    /// One keyset-paginated page of raw plays, newest first, with NO album
    /// resolution at all (contrast `get_history_recent`, which stamps albums via
    /// one batched indexed lookup). All joins are on indexed keys, so a
    /// page is O(limit). Pass `before_ts`/`before_id` = the last row of the
    /// previous page to advance the cursor; pass both `None` for the first page.
    /// Both must be supplied together. Ordering is `(played_at DESC, id DESC)`,
    /// matching the cursor so pages don't overlap or skip on ties.
    pub fn get_history_plays_page(
        &self,
        before_ts: Option<i64>,
        before_id: Option<i64>,
        limit: i64,
    ) -> SqlResult<Vec<HistoryPlayLite>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT hp.id, hp.played_at, ht.display_title, ha.display_name
             FROM history_plays hp
             JOIN history_tracks ht ON ht.id = hp.history_track_id
             JOIN history_artists ha ON ha.id = ht.history_artist_id
             WHERE ?1 IS NULL
                OR hp.played_at < ?1
                OR (hp.played_at = ?1 AND hp.id < ?2)
             ORDER BY hp.played_at DESC, hp.id DESC
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![before_ts, before_id, limit], |row| {
            Ok(HistoryPlayLite {
                id: row.get(0)?,
                played_at: row.get(1)?,
                display_title: row.get(2)?,
                display_artist: row.get(3)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_history_most_played(&self, limit: i64) -> SqlResult<Vec<HistoryMostPlayed>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, play_count, display_title, display_name, rank FROM ( \
               SELECT ht.id, ht.play_count, ht.display_title, ha.display_name, \
                      RANK() OVER (ORDER BY ht.play_count DESC) as rank \
               FROM history_tracks ht \
               JOIN history_artists ha ON ha.id = ht.history_artist_id \
               WHERE ht.play_count > 0 \
             ) ORDER BY play_count DESC LIMIT ?1"
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            Ok(HistoryMostPlayed {
                history_track_id: row.get(0)?,
                play_count: row.get(1)?,
                display_title: row.get(2)?,
                display_artist: row.get(3)?,
                rank: row.get(4)?,
                display_album: None,
                display_album_artist: None,
            })
        })?;
        let mut tracks: Vec<HistoryMostPlayed> = rows.collect::<SqlResult<Vec<_>>>()?;
        stamp_history_albums(&conn, &mut tracks)?;
        Ok(tracks)
    }

    pub fn get_history_most_played_since(&self, since_ts: i64, limit: i64) -> SqlResult<Vec<HistoryMostPlayed>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, cnt, display_title, display_name, rank FROM ( \
               SELECT ht.id, COUNT(*) as cnt, ht.display_title, ha.display_name, \
                      RANK() OVER (ORDER BY COUNT(*) DESC) as rank \
               FROM history_plays hp \
               JOIN history_tracks ht ON ht.id = hp.history_track_id \
               JOIN history_artists ha ON ha.id = ht.history_artist_id \
               WHERE hp.played_at >= ?1 \
               GROUP BY ht.id \
             ) ORDER BY cnt DESC LIMIT ?2"
        )?;
        let rows = stmt.query_map(params![since_ts, limit], |row| {
            Ok(HistoryMostPlayed {
                history_track_id: row.get(0)?,
                play_count: row.get(1)?,
                display_title: row.get(2)?,
                display_artist: row.get(3)?,
                rank: row.get(4)?,
                display_album: None,
                display_album_artist: None,
            })
        })?;
        let mut tracks: Vec<HistoryMostPlayed> = rows.collect::<SqlResult<Vec<_>>>()?;
        stamp_history_albums(&conn, &mut tracks)?;
        Ok(tracks)
    }

    pub fn search_history_tracks(&self, query: &str, limit: i64) -> SqlResult<Vec<HistoryMostPlayed>> {
        let conn = self.conn.lock().unwrap();
        let canonical_query = strip_diacritics(&query.to_lowercase());
        let pattern = format!("%{}%", canonical_query);
        let mut stmt = conn.prepare(
            "SELECT id, play_count, display_title, display_name, rank FROM ( \
               SELECT ht.id, ht.play_count, ht.display_title, ha.display_name, \
                      RANK() OVER (ORDER BY ht.play_count DESC) as rank \
               FROM history_tracks ht \
               JOIN history_artists ha ON ha.id = ht.history_artist_id \
               WHERE ht.play_count > 0 \
                 AND (ht.canonical_title LIKE ?1 OR ha.canonical_name LIKE ?1) \
             ) ORDER BY play_count DESC LIMIT ?2"
        )?;
        let rows = stmt.query_map(params![pattern, limit], |row| {
            Ok(HistoryMostPlayed {
                history_track_id: row.get(0)?,
                play_count: row.get(1)?,
                display_title: row.get(2)?,
                display_artist: row.get(3)?,
                rank: row.get(4)?,
                display_album: None,
                display_album_artist: None,
            })
        })?;
        let mut tracks: Vec<HistoryMostPlayed> = rows.collect::<SqlResult<Vec<_>>>()?;
        stamp_history_albums(&conn, &mut tracks)?;
        Ok(tracks)
    }

    pub fn get_history_most_played_artists_since(&self, since_ts: i64, limit: i64) -> SqlResult<Vec<HistoryArtistStats>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, cnt, track_count, display_name, rank FROM ( \
               SELECT ha.id, COUNT(*) as cnt, \
                      COUNT(DISTINCT ht.id) as track_count, \
                      ha.display_name, \
                      RANK() OVER (ORDER BY COUNT(*) DESC) as rank \
               FROM history_plays hp \
               JOIN history_tracks ht ON ht.id = hp.history_track_id \
               JOIN history_artists ha ON ha.id = ht.history_artist_id \
               WHERE hp.played_at >= ?1 AND ha.canonical_name != '' \
               GROUP BY ha.id \
             ) ORDER BY cnt DESC LIMIT ?2"
        )?;
        let rows = stmt.query_map(params![since_ts, limit], |row| {
            Ok(HistoryArtistStats {
                history_artist_id: row.get(0)?,
                play_count: row.get(1)?,
                track_count: row.get(2)?,
                display_name: row.get(3)?,
                rank: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_history_most_played_artists(&self, limit: i64) -> SqlResult<Vec<HistoryArtistStats>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, play_count, track_count, display_name, rank FROM ( \
               SELECT ha.id, ha.play_count, \
                      (SELECT COUNT(*) FROM history_tracks ht WHERE ht.history_artist_id = ha.id) as track_count, \
                      ha.display_name, \
                      RANK() OVER (ORDER BY ha.play_count DESC) as rank \
               FROM history_artists ha \
               WHERE ha.play_count > 0 AND ha.canonical_name != '' \
             ) ORDER BY play_count DESC LIMIT ?1"
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            Ok(HistoryArtistStats {
                history_artist_id: row.get(0)?,
                play_count: row.get(1)?,
                track_count: row.get(2)?,
                display_name: row.get(3)?,
                rank: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn search_history_artists(&self, query: &str, limit: i64) -> SqlResult<Vec<HistoryArtistStats>> {
        let conn = self.conn.lock().unwrap();
        let canonical_query = strip_diacritics(&query.to_lowercase());
        let pattern = format!("%{}%", canonical_query);
        let mut stmt = conn.prepare(
            "SELECT id, play_count, track_count, display_name, rank FROM ( \
               SELECT ha.id, ha.play_count, \
                      (SELECT COUNT(*) FROM history_tracks ht WHERE ht.history_artist_id = ha.id) as track_count, \
                      ha.display_name, \
                      RANK() OVER (ORDER BY ha.play_count DESC) as rank \
               FROM history_artists ha \
               WHERE ha.play_count > 0 AND ha.canonical_name LIKE ?1 \
             ) ORDER BY play_count DESC LIMIT ?2"
        )?;
        let rows = stmt.query_map(params![pattern, limit], |row| {
            Ok(HistoryArtistStats {
                history_artist_id: row.get(0)?,
                play_count: row.get(1)?,
                track_count: row.get(2)?,
                display_name: row.get(3)?,
                rank: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_track_rank(&self, title: &str, artist_name: Option<&str>) -> SqlResult<Option<i64>> {
        let canonical_title = strip_diacritics(&title.to_lowercase());
        let canonical_artist = strip_diacritics(&artist_name.unwrap_or("").to_lowercase());
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT rank FROM ( \
               SELECT ht.id, RANK() OVER (ORDER BY ht.play_count DESC) as rank \
               FROM history_tracks ht WHERE ht.play_count > 0 \
             ) ranked \
             JOIN history_tracks ht2 ON ht2.id = ranked.id \
             JOIN history_artists ha ON ha.id = ht2.history_artist_id \
             WHERE ht2.canonical_title = ?1 AND ha.canonical_name = ?2",
            params![canonical_title, canonical_artist],
            |row| row.get(0),
        ).optional()
    }

    pub fn get_artist_rank(&self, artist_name: &str) -> SqlResult<Option<i64>> {
        let canonical_name = strip_diacritics(&artist_name.to_lowercase());
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT rank FROM ( \
               SELECT ha.id, RANK() OVER (ORDER BY ha.play_count DESC) as rank \
               FROM history_artists ha WHERE ha.play_count > 0 \
             ) ranked \
             JOIN history_artists ha2 ON ha2.id = ranked.id \
             WHERE ha2.canonical_name = ?1",
            params![canonical_name],
            |row| row.get(0),
        ).optional()
    }

    pub fn get_track_play_history(&self, title: &str, artist_name: Option<&str>, limit: i64) -> SqlResult<Vec<TrackPlayEntry>> {
        let canonical_title = strip_diacritics(&title.to_lowercase());
        let canonical_artist = strip_diacritics(&artist_name.unwrap_or("").to_lowercase());
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT hp.played_at
             FROM history_plays hp
             JOIN history_tracks ht ON ht.id = hp.history_track_id
             JOIN history_artists ha ON ha.id = ht.history_artist_id
             WHERE ht.canonical_title = ?1 AND ha.canonical_name = ?2
             ORDER BY hp.played_at DESC
             LIMIT ?3"
        )?;
        let rows = stmt.query_map(params![canonical_title, canonical_artist, limit], |row| {
            Ok(TrackPlayEntry {
                played_at: row.get(0)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_track_play_stats(&self, title: &str, artist_name: Option<&str>) -> SqlResult<Option<TrackPlayStats>> {
        let canonical_title = strip_diacritics(&title.to_lowercase());
        let canonical_artist = strip_diacritics(&artist_name.unwrap_or("").to_lowercase());
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT ht.play_count, ht.first_played_at, ht.last_played_at
             FROM history_tracks ht
             JOIN history_artists ha ON ha.id = ht.history_artist_id
             WHERE ht.canonical_title = ?1 AND ha.canonical_name = ?2",
            params![canonical_title, canonical_artist],
            |row| Ok(TrackPlayStats {
                play_count: row.get(0)?,
                first_played_at: row.get(1)?,
                last_played_at: row.get(2)?,
            }),
        ).optional()
    }

    /// Attempt to reconnect a ghost history track to a library track by canonical title+artist match.
    /// Returns the matched Track if found, or None if no match exists.
    pub fn reconnect_history_track(&self, history_track_id: i64) -> SqlResult<Option<Track>> {
        let conn = self.conn.lock().unwrap();

        // Look up the history track's canonical info
        let (canonical_title, history_artist_id): (String, i64) = conn.query_row(
            "SELECT canonical_title, history_artist_id FROM history_tracks WHERE id = ?1",
            params![history_track_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let canonical_name: String = conn.query_row(
            "SELECT canonical_name FROM history_artists WHERE id = ?1",
            params![history_artist_id],
            |row| row.get(0),
        )?;

        // Search for a matching library track
        let maybe_track_id: Option<i64> = conn.query_row(
            "SELECT t.id FROM tracks t
             LEFT JOIN artists ar ON t.artist_id = ar.id
             WHERE strip_diacritics(unicode_lower(t.title)) = ?1
             AND strip_diacritics(unicode_lower(COALESCE(ar.name, ''))) = ?2
             LIMIT 1",
            params![canonical_title, canonical_name],
            |row| row.get(0),
        ).optional()?;

        let track_id = match maybe_track_id {
            Some(id) => id,
            None => return Ok(None),
        };

        // Return the full track
        let sql = format!("{} WHERE t.id = ?1", TRACK_SELECT);
        let track = conn.query_row(&sql, params![track_id], |row| track_from_row(row))?;
        Ok(Some(track))
    }

    /// Attempt to reconnect a ghost history artist to a library artist by canonical name match.
    /// Returns the library artist_id if found, or None.
    pub fn reconnect_history_artist(&self, history_artist_id: i64) -> SqlResult<Option<i64>> {
        let conn = self.conn.lock().unwrap();

        let canonical_name: String = conn.query_row(
            "SELECT canonical_name FROM history_artists WHERE id = ?1",
            params![history_artist_id],
            |row| row.get(0),
        )?;

        let maybe_artist_id: Option<i64> = conn.query_row(
            "SELECT id FROM artists
             WHERE strip_diacritics(unicode_lower(name)) = ?1
             LIMIT 1",
            params![canonical_name],
            |row| row.get(0),
        ).optional()?;

        Ok(maybe_artist_id)
    }

    /// Rename or merge history records — the one write history has besides
    /// recording a play.
    ///
    /// History is keyed by normalized name, deliberately decoupled from library
    /// ids, so correcting a library tag (greeklish → Greek, a typo, a mojibake
    /// artist) leaves every past play stranded under the old spelling. This
    /// re-files those plays under the corrected name:
    ///
    /// - **Artist mode** (`from_title == None`): every history track of
    ///   `from_artist` moves to `to_artist`. `to_title` is ignored.
    /// - **Track mode** (`from_title == Some`): the one history track moves to
    ///   `to_artist` (default: same artist) and/or `to_title` (default: same
    ///   title). At least one must change or the call is a display-name touch.
    ///
    /// When the target name already exists in history the move is a **merge**:
    /// `history_plays` are re-pointed at the surviving track, its counters are
    /// recomputed from the plays, and the source row is deleted. An artist
    /// left with no tracks is deleted too. Display names are always set to
    /// the caller's spelling — the whole point of the call is that the caller
    /// holds the correct one. Timestamps are never touched: a play stays a
    /// play, on the day it happened.
    ///
    /// `dry_run` runs the same transaction and rolls it back, so the reported
    /// counts and the merge flags are exactly what an apply would do.
    ///
    /// Returns `Ok(None)` when the source (artist, or artist+title) has no
    /// history at all — a caller-facing "nothing to rename", not an error.
    pub fn rename_history(
        &self,
        from_artist: &str,
        from_title: Option<&str>,
        to_artist: Option<&str>,
        to_title: Option<&str>,
        dry_run: bool,
    ) -> SqlResult<Option<HistoryRenameResult>> {
        let canon = |s: &str| strip_diacritics(&s.to_lowercase());
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;

        let from_canon_artist = canon(from_artist);
        let Some(src_artist_id) = tx
            .query_row(
                "SELECT id FROM history_artists WHERE canonical_name = ?1",
                params![from_canon_artist],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
        else {
            return Ok(None);
        };

        // Resolve the target artist: the caller's, else the source itself.
        // Same canonical name = a display-name touch, not a move.
        let to_artist_name = to_artist.unwrap_or(from_artist);
        let to_canon_artist = canon(to_artist_name);
        let (target_artist_id, artist_merged) = if to_canon_artist == from_canon_artist {
            (src_artist_id, false)
        } else {
            let existing: Option<i64> = tx
                .query_row(
                    "SELECT id FROM history_artists WHERE canonical_name = ?1",
                    params![to_canon_artist],
                    |row| row.get(0),
                )
                .optional()?;
            match existing {
                Some(id) => (id, true),
                None => {
                    tx.execute(
                        "INSERT INTO history_artists (canonical_name, display_name, first_played_at, last_played_at, play_count)
                         SELECT ?1, ?2, first_played_at, last_played_at, 0 FROM history_artists WHERE id = ?3",
                        params![to_canon_artist, to_artist_name, src_artist_id],
                    )?;
                    (tx.last_insert_rowid(), false)
                }
            }
        };
        // The caller's spelling wins on the surviving artist row.
        tx.execute(
            "UPDATE history_artists SET display_name = ?1 WHERE id = ?2",
            params![to_artist_name, target_artist_id],
        )?;

        // The tracks to move: (id, canonical_title) → target canonical title.
        // Artist mode keeps every title; track mode may retitle the one track.
        let moves: Vec<(i64, String, Option<&str>)> = match from_title {
            None => {
                let mut stmt = tx.prepare(
                    "SELECT id, canonical_title FROM history_tracks WHERE history_artist_id = ?1",
                )?;
                let rows = stmt
                    .query_map(params![src_artist_id], |row| {
                        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                    })?
                    .collect::<SqlResult<Vec<_>>>()?;
                rows.into_iter().map(|(id, c)| (id, c, None)).collect()
            }
            Some(title) => {
                let Some(track_id) = tx
                    .query_row(
                        "SELECT id FROM history_tracks WHERE history_artist_id = ?1 AND canonical_title = ?2",
                        params![src_artist_id, canon(title)],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?
                else {
                    return Ok(None);
                };
                let target_title = to_title.map(canon).unwrap_or_else(|| canon(title));
                vec![(track_id, target_title, to_title)]
            }
        };

        let mut tracks_moved: i64 = 0;
        let mut plays_moved: i64 = 0;
        let mut tracks_merged: i64 = 0;
        for (track_id, target_canon_title, new_display_title) in &moves {
            let collision: Option<i64> = tx
                .query_row(
                    "SELECT id FROM history_tracks
                     WHERE history_artist_id = ?1 AND canonical_title = ?2 AND id != ?3",
                    params![target_artist_id, target_canon_title, track_id],
                    |row| row.get(0),
                )
                .optional()?;
            match collision {
                Some(survivor) => {
                    let n = tx.execute(
                        "UPDATE history_plays SET history_track_id = ?1 WHERE history_track_id = ?2",
                        params![survivor, track_id],
                    )?;
                    plays_moved += n as i64;
                    tx.execute("DELETE FROM history_tracks WHERE id = ?1", params![track_id])?;
                    tx.execute(
                        "UPDATE history_tracks SET
                            play_count      = (SELECT COUNT(*)        FROM history_plays WHERE history_track_id = ?1),
                            first_played_at = (SELECT MIN(played_at)  FROM history_plays WHERE history_track_id = ?1),
                            last_played_at  = (SELECT MAX(played_at)  FROM history_plays WHERE history_track_id = ?1),
                            display_title   = COALESCE(?2, display_title)
                         WHERE id = ?1",
                        params![survivor, new_display_title],
                    )?;
                    tracks_merged += 1;
                }
                None => {
                    let n: i64 = tx.query_row(
                        "SELECT play_count FROM history_tracks WHERE id = ?1",
                        params![track_id],
                        |row| row.get(0),
                    )?;
                    plays_moved += n;
                    tx.execute(
                        "UPDATE history_tracks SET
                            history_artist_id = ?1,
                            canonical_title   = ?2,
                            display_title     = COALESCE(?3, display_title)
                         WHERE id = ?4",
                        params![target_artist_id, target_canon_title, new_display_title, track_id],
                    )?;
                }
            }
            tracks_moved += 1;
        }

        // Re-derive both artists' counters from what is filed under them now,
        // then drop the source if it emptied out.
        for artist_id in [target_artist_id, src_artist_id] {
            tx.execute(
                "UPDATE history_artists SET
                    play_count      = (SELECT COALESCE(SUM(play_count), 0) FROM history_tracks WHERE history_artist_id = ?1),
                    first_played_at = (SELECT MIN(first_played_at)         FROM history_tracks WHERE history_artist_id = ?1),
                    last_played_at  = (SELECT MAX(last_played_at)          FROM history_tracks WHERE history_artist_id = ?1)
                 WHERE id = ?1",
                params![artist_id],
            )?;
        }
        let artist_removed = if src_artist_id != target_artist_id {
            tx.execute(
                "DELETE FROM history_artists
                 WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM history_tracks WHERE history_artist_id = ?1)",
                params![src_artist_id],
            )? > 0
        } else {
            false
        };

        if dry_run {
            tx.rollback()?;
        } else {
            tx.commit()?;
        }

        Ok(Some(HistoryRenameResult {
            mode: if from_title.is_some() { "track" } else { "artist" }.to_string(),
            from: HistoryName {
                artist: from_artist.to_string(),
                title: from_title.map(str::to_string),
            },
            to: HistoryName {
                artist: to_artist_name.to_string(),
                title: from_title.map(|t| to_title.unwrap_or(t).to_string()),
            },
            tracks_moved,
            plays_moved,
            tracks_merged,
            artist_merged,
            artist_removed,
            dry_run,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn test_db() -> Database {
        Database::new_in_memory().unwrap()
    }

    fn seed_plays(db: &Database, plays: &[(&str, &str, i64)]) {
        let owned: Vec<(String, String, i64)> = plays
            .iter()
            .map(|(a, t, ts)| (a.to_string(), t.to_string(), *ts))
            .collect();
        let (imported, _skipped) = db.record_history_plays_batch(&owned).unwrap();
        assert_eq!(imported as usize, plays.len());
    }

    // Drain the whole history via keyset paging, returning play ids newest-first.
    fn page_all(db: &Database, page: i64) -> Vec<i64> {
        let mut out = Vec::new();
        let mut before_ts: Option<i64> = None;
        let mut before_id: Option<i64> = None;
        loop {
            let rows = db.get_history_plays_page(before_ts, before_id, page).unwrap();
            if rows.is_empty() {
                break;
            }
            for r in &rows {
                out.push(r.id);
            }
            let last = rows.last().unwrap();
            before_ts = Some(last.played_at);
            before_id = Some(last.id);
            if (rows.len() as i64) < page {
                break;
            }
        }
        out
    }

    #[test]
    fn test_history_play_count() {
        let db = test_db();
        assert_eq!(db.get_history_play_count().unwrap(), 0);
        seed_plays(&db, &[("A", "t1", 100), ("A", "t2", 200), ("B", "t3", 300)]);
        assert_eq!(db.get_history_play_count().unwrap(), 3);
    }

    // (canonical_name, display_name, play_count, track_count) per history artist.
    fn history_artists(db: &Database) -> Vec<(String, String, i64, i64)> {
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT a.canonical_name, a.display_name, a.play_count,
                        (SELECT COUNT(*) FROM history_tracks t WHERE t.history_artist_id = a.id)
                 FROM history_artists a ORDER BY a.canonical_name",
            )
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<SqlResult<Vec<_>>>()
            .unwrap()
    }

    // (canonical_title, display_title, play_count, first, last) for one artist.
    fn history_tracks_of(db: &Database, canonical_artist: &str) -> Vec<(String, String, i64, i64, i64)> {
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT t.canonical_title, t.display_title, t.play_count, t.first_played_at, t.last_played_at
                 FROM history_tracks t JOIN history_artists a ON a.id = t.history_artist_id
                 WHERE a.canonical_name = ?1 ORDER BY t.canonical_title",
            )
            .unwrap();
        stmt.query_map(params![canonical_artist], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .unwrap()
        .collect::<SqlResult<Vec<_>>>()
        .unwrap()
    }

    /// Artist mode onto a name history has never seen: a plain rename. Every
    /// track follows, the artist row keeps its id-independent identity under
    /// the new canonical name, and the caller's spelling becomes the display.
    #[test]
    fn test_rename_history_artist_to_new_name_moves_every_track() {
        let db = test_db();
        seed_plays(&db, &[
            ("Stelios Kazantzidis", "Gialinos Kosmos", 100),
            ("Stelios Kazantzidis", "Gialinos Kosmos", 200),
            ("Stelios Kazantzidis", "Iparho", 300),
            ("Other", "x", 400),
        ]);

        let r = db
            .rename_history("stelios kazantzidis", None, Some("Στέλιος Καζαντζίδης"), None, false)
            .unwrap()
            .unwrap();
        assert_eq!(r.mode, "artist");
        assert_eq!((r.tracks_moved, r.plays_moved, r.tracks_merged), (2, 3, 0));
        assert!(!r.artist_merged);
        assert!(r.artist_removed);
        assert!(!r.dry_run);
        assert_eq!(r.to, HistoryName { artist: "Στέλιος Καζαντζίδης".into(), title: None });

        let artists = history_artists(&db);
        assert_eq!(artists, vec![
            ("other".to_string(), "Other".to_string(), 1, 1),
            ("στελιος καζαντζιδης".to_string(), "Στέλιος Καζαντζίδης".to_string(), 3, 2),
        ]);
        // Plays untouched: 3 seeded, 3 still counted, timestamps kept.
        assert_eq!(db.get_history_play_count().unwrap(), 4);
        let tracks = history_tracks_of(&db, "στελιος καζαντζιδης");
        assert_eq!(tracks[0], ("gialinos kosmos".into(), "Gialinos Kosmos".into(), 2, 100, 200));
        assert_eq!(tracks[1], ("iparho".into(), "Iparho".into(), 1, 300, 300));
        // The reads that power Home/History see the new name.
        let top = db.get_history_most_played_artists(5).unwrap();
        assert_eq!(top[0].display_name, "Στέλιος Καζαντζίδης");
        assert_eq!(top[0].play_count, 3);
    }

    /// Artist mode onto an artist that already has history: a merge. Titles
    /// that exist on both sides fold their plays together and the counters
    /// are re-derived from the plays, not summed from possibly-stale counts.
    #[test]
    fn test_rename_history_artist_merges_colliding_tracks() {
        let db = test_db();
        seed_plays(&db, &[
            ("Vassilis Tsitsanis", "Sinnefiasmeni Kiriaki", 100),
            ("Vassilis Tsitsanis", "Aspro Poukamiso", 150),
            ("Βασίλης Τσιτσάνης", "Sinnefiasmeni Kiriaki", 500),
            ("Βασίλης Τσιτσάνης", "Μπαξέ Τσιφλίκι", 600),
        ]);

        let r = db
            .rename_history("Vassilis Tsitsanis", None, Some("Βασίλης Τσιτσάνης"), None, false)
            .unwrap()
            .unwrap();
        assert_eq!((r.tracks_moved, r.plays_moved, r.tracks_merged), (2, 2, 1));
        assert!(r.artist_merged);
        assert!(r.artist_removed);

        let artists = history_artists(&db);
        assert_eq!(artists.len(), 1);
        assert_eq!(artists[0].1, "Βασίλης Τσιτσάνης");
        assert_eq!((artists[0].2, artists[0].3), (4, 3));
        let tracks = history_tracks_of(&db, "βασιλης τσιτσανης");
        let merged = tracks.iter().find(|t| t.0 == "sinnefiasmeni kiriaki").unwrap();
        // 2 plays, spanning both sides' timestamps.
        assert_eq!((merged.2, merged.3, merged.4), (2, 100, 500));
        assert_eq!(db.get_history_play_count().unwrap(), 4);
    }

    /// Track mode: retitle one track, optionally re-filing it under another
    /// artist in the same call. Sibling tracks stay put; the source artist
    /// survives while it still has tracks.
    #[test]
    fn test_rename_history_track_retitles_and_can_move_artist() {
        let db = test_db();
        seed_plays(&db, &[
            ("Active Member", "Mia Fora", 100),
            ("Active Member", "Mia Fora", 200),
            ("Active Member", "Pame", 300),
            ("Some Band", "Μια φορά", 50),
        ]);

        // Title only.
        let r = db
            .rename_history("Active Member", Some("mia fora"), None, Some("Μια Φορά"), false)
            .unwrap()
            .unwrap();
        assert_eq!(r.mode, "track");
        assert_eq!((r.tracks_moved, r.plays_moved, r.tracks_merged), (1, 2, 0));
        assert!(!r.artist_removed);
        assert_eq!(
            r.to,
            HistoryName { artist: "Active Member".into(), title: Some("Μια Φορά".into()) }
        );
        let tracks = history_tracks_of(&db, "active member");
        assert_eq!(tracks.iter().map(|t| t.1.as_str()).collect::<Vec<_>>(), vec!["Pame", "Μια Φορά"]);

        // Title + artist, colliding with Some Band's own copy → merge into it.
        let r = db
            .rename_history("Active Member", Some("Μια Φορά"), Some("Some Band"), Some("Μια φορά"), false)
            .unwrap()
            .unwrap();
        assert_eq!((r.tracks_moved, r.plays_moved, r.tracks_merged), (1, 2, 1));
        assert!(r.artist_merged);
        assert!(!r.artist_removed, "Active Member still has Pame");
        let some_band = history_tracks_of(&db, "some band");
        assert_eq!(some_band.len(), 1);
        assert_eq!((some_band[0].2, some_band[0].3, some_band[0].4), (3, 50, 200));
        let artists = history_artists(&db);
        assert_eq!(artists, vec![
            ("active member".to_string(), "Active Member".to_string(), 1, 1),
            ("some band".to_string(), "Some Band".to_string(), 3, 1),
        ]);
    }

    /// Same canonical name = the caller is fixing casing/accents only. Nothing
    /// moves, no artist is created or removed, the display strings update.
    #[test]
    fn test_rename_history_same_canonical_name_only_touches_display() {
        let db = test_db();
        seed_plays(&db, &[("bjork", "joga", 100)]);
        let r = db
            .rename_history("BJORK", Some("JOGA"), Some("Björk"), Some("Jóga"), false)
            .unwrap()
            .unwrap();
        assert_eq!((r.tracks_moved, r.plays_moved, r.tracks_merged), (1, 1, 0));
        assert!(!r.artist_merged && !r.artist_removed);
        assert_eq!(history_artists(&db), vec![("bjork".to_string(), "Björk".to_string(), 1, 1)]);
        assert_eq!(history_tracks_of(&db, "bjork")[0].1, "Jóga");
    }

    /// A dry run reports exactly what an apply would and leaves no trace —
    /// including no target artist row created on the way to the answer.
    #[test]
    fn test_rename_history_dry_run_changes_nothing() {
        let db = test_db();
        seed_plays(&db, &[("Old", "a", 100), ("Old", "b", 200), ("New", "a", 300)]);
        let before_artists = history_artists(&db);
        let before_old = history_tracks_of(&db, "old");

        let dry = db.rename_history("Old", None, Some("New"), None, true).unwrap().unwrap();
        assert!(dry.dry_run);
        assert_eq!((dry.tracks_moved, dry.plays_moved, dry.tracks_merged), (2, 2, 1));
        assert!(dry.artist_merged && dry.artist_removed);
        assert_eq!(history_artists(&db), before_artists);
        assert_eq!(history_tracks_of(&db, "old"), before_old);

        let wet = db.rename_history("Old", None, Some("New"), None, false).unwrap().unwrap();
        assert_eq!(
            (wet.tracks_moved, wet.plays_moved, wet.tracks_merged, wet.artist_merged, wet.artist_removed),
            (dry.tracks_moved, dry.plays_moved, dry.tracks_merged, dry.artist_merged, dry.artist_removed)
        );
        assert_eq!(history_artists(&db).len(), 1);
    }

    /// Unknown source → `None`, and a target artist probed on the way is not
    /// left behind (the transaction rolls back).
    #[test]
    fn test_rename_history_unknown_source_is_none_and_leaves_nothing() {
        let db = test_db();
        seed_plays(&db, &[("A", "t", 100)]);
        assert!(db.rename_history("Nobody", None, Some("B"), None, false).unwrap().is_none());
        assert!(db.rename_history("A", Some("missing"), Some("B"), None, false).unwrap().is_none());
        assert_eq!(history_artists(&db).len(), 1);
    }

    #[test]
    fn test_plays_page_keyset_covers_all_newest_first() {
        let db = test_db();
        seed_plays(
            &db,
            &[
                ("A", "t1", 100),
                ("A", "t2", 200),
                ("B", "t3", 300),
                ("B", "t4", 400),
                ("C", "t5", 500),
            ],
        );

        // First page (no cursor) is the newest rows, descending.
        let first = db.get_history_plays_page(None, None, 2).unwrap();
        assert_eq!(first.len(), 2);
        assert_eq!(first[0].played_at, 500);
        assert_eq!(first[1].played_at, 400);

        // Paging by 2 visits every play exactly once.
        let ids = page_all(&db, 2);
        assert_eq!(ids.len(), 5);
        assert_eq!(ids.iter().cloned().collect::<HashSet<i64>>().len(), 5, "no play returned twice");

        // A single big page returns all plays strictly descending by played_at.
        let all = db.get_history_plays_page(None, None, 100).unwrap();
        let times: Vec<i64> = all.iter().map(|r| r.played_at).collect();
        assert_eq!(times, vec![500, 400, 300, 200, 100]);
    }

    #[test]
    fn test_plays_page_handles_played_at_ties() {
        let db = test_db();
        // Three plays share played_at = 100; the (played_at, id) keyset must still
        // page through them without skipping or duplicating any.
        seed_plays(
            &db,
            &[("A", "t1", 100), ("B", "t2", 100), ("C", "t3", 100), ("D", "t4", 50)],
        );
        let ids = page_all(&db, 2);
        assert_eq!(ids.len(), 4);
        assert_eq!(ids.iter().cloned().collect::<HashSet<i64>>().len(), 4, "tie rows skipped or duplicated");
        // Oldest play (ts=50) sorts last in newest-first order.
        let all = db.get_history_plays_page(None, None, 10).unwrap();
        assert_eq!(all.last().unwrap().played_at, 50);
    }

    /// The audio/video split must name exactly what the scanner indexed as
    /// video. These drifted twice (four-container copies against the scanner's
    /// seven), which made .mkv/.avi/.wmv video to some surfaces and audio to
    /// others. The shared items in db/mod.rs are now the only SQL source —
    /// every media-type filter, collection stats, radio and auto-continue all
    /// build from them.
    #[test]
    fn test_format_clauses_cover_every_scanned_video_extension() {
        for ext in crate::scanner::VIDEO_EXTENSIONS {
            let quoted = format!("'{}'", ext);
            assert!(
                VIDEO_FORMAT_LIST.contains(&quoted),
                "format list is missing {} — it must list every scanner::VIDEO_EXTENSIONS entry",
                ext
            );
            assert!(
                VIDEO_FORMAT_CLAUSE.contains(&quoted),
                "video clause is missing {} — it must list every scanner::VIDEO_EXTENSIONS entry",
                ext
            );
            assert!(
                AUDIO_FORMAT_CLAUSE.contains(&quoted),
                "audio clause fails to exclude {} — it must exclude every scanner::VIDEO_EXTENSIONS entry",
                ext
            );
            assert!(
                is_video_format(Some(ext)),
                "is_video_format disagrees with the scanner about {}",
                ext
            );
        }
        assert_eq!(media_type_clause(Some("video")), VIDEO_FORMAT_CLAUSE.as_str());
        assert_eq!(media_type_clause(Some("audio")), AUDIO_FORMAT_CLAUSE.as_str());
        assert_eq!(media_type_clause(Some("anything-else")), "");
        assert_eq!(media_type_clause(None), "");
        assert!(!is_video_format(Some("flac")));
        assert!(!is_video_format(None));
    }

    /// A station seeded from a video stays video, whichever container that video
    /// happens to be in. Before the lists were unified, an .mkv seed fell to the
    /// audio clause and pulled the whole audio library into the station.
    #[test]
    fn test_radio_from_video_seed_excludes_audio_for_every_container() {
        for ext in crate::scanner::VIDEO_EXTENSIONS {
            let db = test_db();
            db.upsert_track(
                &format!("v/seed.{}", ext), "Seed Concert", None, None, None,
                Some(300.0), Some(ext), None, None, None, None,
            ).unwrap();
            db.upsert_track(
                &format!("v/other.{}", ext), "Other Concert", None, None, None,
                Some(300.0), Some(ext), None, None, None, None,
            ).unwrap();
            for (i, audio) in ["mp3", "flac", "opus"].iter().enumerate() {
                db.upsert_track(
                    &format!("a/song{}.{}", i, audio), &format!("Song {}", i), None, None, None,
                    Some(200.0), Some(audio), None, None, None, None,
                ).unwrap();
            }

            let station = db.build_radio_for_track("Seed Concert", None, 5).unwrap();
            assert!(!station.is_empty(), "{}: station came back empty", ext);
            for track in &station {
                assert!(
                    is_video_format(track.format.as_deref()),
                    "{} seed pulled a non-video track into the station: {:?}",
                    ext,
                    track.format
                );
            }
        }
    }
    /// The batched history album lookup must be served by the
    /// `idx_tracks_title_norm` expression index (run_migrations #8). Without it
    /// every History query — including the per-keystroke search — pays a full
    /// tracks scan evaluating two UDFs per row, which is exactly the cost that
    /// made album resolution unaffordable on this surface before. An expression
    /// index only serves an exactly-matching expression, so this fails if the
    /// query's WHERE drifts from the index's definition.
    #[test]
    fn test_history_album_lookup_uses_the_title_index() {
        let db = test_db();
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {}", history_album_sql(3)))
            .unwrap();
        let nulls = vec![rusqlite::types::Value::Null; stmt.parameter_count()];
        let refs: Vec<&dyn rusqlite::types::ToSql> =
            nulls.iter().map(|v| v as &dyn rusqlite::types::ToSql).collect();
        let details: Vec<String> = stmt
            .query_map(refs.as_slice(), |r| r.get::<_, String>(3))
            .unwrap()
            .collect::<SqlResult<Vec<_>>>()
            .unwrap();
        assert!(
            details.iter().any(|d| d.contains("idx_tracks_title_norm")),
            "history album lookup should use idx_tracks_title_norm, got: {details:?}"
        );
    }
}
