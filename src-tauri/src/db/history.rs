// Auto-split from db.rs. Shared types/helpers live in db/mod.rs;
// these are inherent `impl Database` methods reachable via `use super::*`.
use super::*;

// Video container formats as stored in `tracks.format`. Auto-continue and radio
// share these clauses so their audio/video filtering can't drift apart.
const VIDEO_FORMAT_CLAUSE: &str = " AND LOWER(t.format) IN ('mp4','m4v','mov','webm')";
const AUDIO_FORMAT_CLAUSE: &str =
    " AND (t.format IS NULL OR LOWER(t.format) NOT IN ('mp4','m4v','mov','webm'))";

/// True when a `tracks.format` value names a video container.
fn is_video_format(format: Option<&str>) -> bool {
    matches!(
        format.map(|f| f.to_lowercase()).as_deref(),
        Some("mp4") | Some("m4v") | Some("mov") | Some("webm")
    )
}

impl Database {

    // --- Play history ---

    #[cfg(test)]
    pub fn record_play(&self, track_id: i64) -> SqlResult<()> {
        self.record_history_play(track_id)
    }

    pub fn get_auto_continue_track(&self, strategy: &str, current_title: &str, current_artist: Option<&str>, format_filter: Option<&str>, exclude_ids: &[i64]) -> SqlResult<Option<Track>> {
        let conn = self.conn.lock().unwrap();

        let format_clause = match format_filter {
            Some("video") => VIDEO_FORMAT_CLAUSE,
            Some("audio") => AUDIO_FORMAT_CLAUSE,
            _ => "",
        };

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
            VIDEO_FORMAT_CLAUSE
        } else {
            AUDIO_FORMAT_CLAUSE
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

    pub fn pick_radio_seeds(&self, count: u32) -> SqlResult<Vec<Track>> {
        if count == 0 {
            return Ok(Vec::new());
        }

        let conn = self.conn.lock().unwrap();
        let now_ts: i64 = conn.query_row("SELECT strftime('%s', 'now')", [], |row| {
            let s: String = row.get(0)?;
            Ok(s.parse::<i64>().unwrap_or(0))
        })?;
        let cutoff = now_ts - 30 * 24 * 60 * 60;
        let overfetch = (count as i64) * 4;

        let sql = format!(
            "{} \
             LEFT JOIN history_artists ha ON ha.canonical_name = strip_diacritics(unicode_lower(COALESCE(ar.name, ''))) \
             LEFT JOIN history_tracks ht ON ht.history_artist_id = ha.id \
                  AND ht.canonical_title = strip_diacritics(unicode_lower(t.title)) \
             LEFT JOIN history_plays hp ON hp.history_track_id = ht.id AND hp.played_at >= ?1 \
             WHERE t.liked != -1 {} \
             GROUP BY t.id \
             ORDER BY (\
                 CASE WHEN t.liked = 1 THEN 2 ELSE 0 END + \
                 CASE WHEN COUNT(hp.id) > 0 THEN 3 ELSE 0 END + \
                 (RANDOM() % 1000) * 0.0001 \
             ) DESC \
             LIMIT ?2",
            TRACK_SELECT, ENABLED_COLLECTION_FILTER
        );

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![cutoff, overfetch], |row| track_from_row(row))?;

        let candidates: Vec<Track> = rows.collect::<SqlResult<Vec<_>>>()?;

        // Artist-distinct pass.
        let mut chosen: Vec<Track> = Vec::with_capacity(count as usize);
        let mut seen_artists: std::collections::HashSet<i64> = std::collections::HashSet::new();
        for t in &candidates {
            if (chosen.len() as u32) >= count { break; }
            if let Some(aid) = t.artist_id {
                if seen_artists.insert(aid) {
                    chosen.push(t.clone());
                }
            } else {
                chosen.push(t.clone());
            }
        }
        // Fill remainder ignoring distinct rule if needed.
        if (chosen.len() as u32) < count {
            let chosen_ids: std::collections::HashSet<i64> = chosen.iter().map(|t| t.id).collect();
            for t in candidates {
                if (chosen.len() as u32) >= count { break; }
                if !chosen_ids.contains(&t.id) {
                    chosen.push(t);
                }
            }
        }

        Ok(chosen)
    }

    // --- Decoupled history ---

    #[cfg(test)]
    pub fn record_history_play(&self, track_id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        // Fetch track metadata
        let (title, artist_name): (String, Option<String>) = conn.query_row(
            "SELECT t.title, ar.name FROM tracks t
             LEFT JOIN artists ar ON t.artist_id = ar.id
             WHERE t.id = ?1",
            params![track_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        let canonical_artist = strip_diacritics(&artist_name.as_deref().unwrap_or("").to_lowercase());
        let canonical_title = strip_diacritics(&title.to_lowercase());

        // Upsert history_artists/tracks
        conn.execute(
            "INSERT INTO history_artists (canonical_name, display_name, first_played_at, last_played_at, play_count)
             VALUES (?1, ?2, strftime('%s', 'now'), strftime('%s', 'now'), 0)
             ON CONFLICT(canonical_name) DO UPDATE SET
               display_name = excluded.display_name",
            params![canonical_artist, artist_name],
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
            params![history_artist_id, canonical_title, title],
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

    pub fn record_play_by_metadata(&self, title: &str, artist_name: Option<&str>) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();

        let artist = artist_name.unwrap_or("");
        let canonical_artist = strip_diacritics(&artist.to_lowercase());
        let canonical_title = strip_diacritics(&title.to_lowercase());

        conn.execute(
            "INSERT INTO history_artists (canonical_name, display_name, first_played_at, last_played_at, play_count)
             VALUES (?1, ?2, strftime('%s', 'now'), strftime('%s', 'now'), 0)
             ON CONFLICT(canonical_name) DO UPDATE SET
               display_name = excluded.display_name",
            params![canonical_artist, artist],
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
            params![history_artist_id, canonical_title, title],
        )?;
        let history_track_id: i64 = conn.query_row(
            "SELECT id FROM history_tracks WHERE history_artist_id = ?1 AND canonical_title = ?2",
            params![history_artist_id, canonical_title],
            |row| row.get(0),
        )?;

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

        conn.execute(
            "INSERT INTO history_plays (history_track_id) VALUES (?1)",
            params![history_track_id],
        )?;
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
        let mut stmt = conn.prepare(
            "SELECT hp.id, ht.id, hp.played_at, ht.display_title, ha.display_name,
                    ht.play_count
             FROM history_plays hp
             JOIN history_tracks ht ON ht.id = hp.history_track_id
             JOIN history_artists ha ON ha.id = ht.history_artist_id
             ORDER BY hp.played_at DESC
             LIMIT ?1"
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            Ok(HistoryEntry {
                id: row.get(0)?,
                history_track_id: row.get(1)?,
                played_at: row.get(2)?,
                display_title: row.get(3)?,
                display_artist: row.get(4)?,
                play_count: row.get(5)?,
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
            })
        })?;
        rows.collect()
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
            })
        })?;
        rows.collect()
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
            })
        })?;
        rows.collect()
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
}
