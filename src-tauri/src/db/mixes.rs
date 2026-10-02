// Home "Forgotten favorites" mixes: the forgotten pool grouped by tag.
// Inherent `impl Database` methods plus the pure grouping helper (unit-tested
// at the bottom). "Discover by decade" is not here — Home reads the Playlists
// view's auto decade mixes (`auto_playlists.rs`) instead of building its own.
use super::*;
use std::collections::{HashMap, HashSet};
use crate::db::likes::norm_segment;

/// Fewest tracks a mix may hold. A tag that can't fill this many is not
/// offered as a card — a two-track "playlist" reads as a bug, not a mix.
pub(crate) const MIN_MIX_TRACKS: usize = 6;
/// Most tracks by one artist inside a single mix, so a tag dominated by one
/// prolific artist still reads as a mix rather than that artist's discography.
pub(crate) const MIX_MAX_PER_ARTIST: usize = 3;

fn artist_key(t: &Track) -> String {
    match t.artist_id {
        Some(id) => format!("#{id}"),
        None => norm_segment(t.artist_name.as_deref()),
    }
}

/// Take up to `size` tracks from `candidates` (in order), skipping any whose
/// artist already has `per_artist` tracks. Returns the indices taken.
fn take_spread(
    candidates: impl Iterator<Item = usize>,
    tracks: &[&Track],
    size: usize,
    per_artist: usize,
) -> Vec<usize> {
    let mut by_artist: HashMap<String, usize> = HashMap::new();
    let mut taken = Vec::new();
    for i in candidates {
        if taken.len() >= size {
            break;
        }
        let a = by_artist.entry(artist_key(tracks[i])).or_insert(0);
        if *a >= per_artist {
            continue;
        }
        *a += 1;
        taken.push(i);
    }
    taken
}

/// Group a shuffled pool of (track, tag names) into up to `max_mixes` mixes.
///
/// Greedy by tag: the tag covering the most still-unassigned tracks becomes the
/// next mix (ties go to the tag whose first track sits earliest in the pool, so
/// which tag wins a tie follows the shuffle rather than the alphabet), filled
/// in pool order under the per-artist cap. Each track lands in at most one mix.
/// What no tag can hold becomes one catch-all mix (`tag: None`) at the end.
/// Tags compare case- and accent-insensitively; a mix shows the spelling of
/// its first track.
pub(crate) fn group_by_tag(
    pool: &[(Track, Vec<String>)],
    max_mixes: usize,
    mix_size: usize,
) -> Vec<TrackMix> {
    let tracks: Vec<&Track> = pool.iter().map(|(t, _)| t).collect();
    let tag_keys: Vec<Vec<(String, &str)>> = pool
        .iter()
        .map(|(_, tags)| {
            let mut seen = HashSet::new();
            tags.iter()
                .map(|n| (norm_segment(Some(n)), n.as_str()))
                .filter(|(k, _)| !k.is_empty() && seen.insert(k.clone()))
                .collect()
        })
        .collect();
    let mut assigned = vec![false; pool.len()];
    let mut exhausted: HashSet<String> = HashSet::new();
    let mut mixes = Vec::new();

    while mixes.len() < max_mixes {
        // key -> (display name, unassigned count, first index)
        let mut counts: HashMap<&str, (&str, usize, usize)> = HashMap::new();
        for (i, keys) in tag_keys.iter().enumerate() {
            if assigned[i] {
                continue;
            }
            for (k, name) in keys {
                if exhausted.contains(k) {
                    continue;
                }
                let e = counts.entry(k.as_str()).or_insert((name, 0, i));
                e.1 += 1;
            }
        }
        let best = counts
            .iter()
            .filter(|(_, (_, n, _))| *n >= MIN_MIX_TRACKS)
            .max_by(|a, b| a.1 .1.cmp(&b.1 .1).then(b.1 .2.cmp(&a.1 .2)))
            .map(|(k, (name, _, _))| (k.to_string(), name.to_string()));
        let Some((key, name)) = best else { break };
        let candidates = (0..pool.len())
            .filter(|&i| !assigned[i] && tag_keys[i].iter().any(|(k, _)| *k == key));
        let taken = take_spread(candidates, &tracks, mix_size, MIX_MAX_PER_ARTIST);
        exhausted.insert(key);
        if taken.len() < MIN_MIX_TRACKS {
            // The artist cap thinned it below a mix; leave its tracks for others.
            continue;
        }
        for &i in &taken {
            assigned[i] = true;
        }
        mixes.push(TrackMix {
            tag: Some(name),
            tracks: taken.iter().map(|&i| tracks[i].clone()).collect(),
        });
    }

    if mixes.len() < max_mixes {
        let rest = take_spread(
            (0..pool.len()).filter(|&i| !assigned[i]),
            &tracks,
            mix_size,
            MIX_MAX_PER_ARTIST,
        );
        if rest.len() >= MIN_MIX_TRACKS {
            mixes.push(TrackMix {
                tag: None,
                tracks: rest.iter().map(|&i| tracks[i].clone()).collect(),
            });
        }
    }
    mixes
}

impl Database {
    /// Tag names per track id, for the given ids (chunked under SQLite's
    /// bound-parameter limit). Ids without tags are absent from the map.
    fn tag_names_for_tracks(&self, ids: &[i64]) -> SqlResult<HashMap<i64, Vec<String>>> {
        let conn = self.conn.lock().unwrap();
        let mut out: HashMap<i64, Vec<String>> = HashMap::new();
        for chunk in ids.chunks(500) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!(
                "SELECT tt.track_id, tg.name FROM track_tags tt \
                 JOIN tags tg ON tg.id = tt.tag_id \
                 WHERE tt.track_id IN ({placeholders}) \
                 ORDER BY tt.track_id, tg.track_count DESC"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(rusqlite::params_from_iter(chunk.iter()), |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (id, name) = row?;
                out.entry(id).or_default().push(name);
            }
        }
        Ok(out)
    }

    /// The Home "Forgotten favorites" shelf: the forgotten-favorites pool
    /// (weighted shuffle, see `pick_forgotten_favorites`) grouped by tag into
    /// up to `max_mixes` playlists of up to `mix_size` tracks. Fresh each call.
    pub fn pick_forgotten_mixes(&self, max_mixes: usize, mix_size: usize) -> SqlResult<Vec<TrackMix>> {
        if max_mixes == 0 || mix_size == 0 {
            return Ok(Vec::new());
        }
        // Three tracks in the pool per slot: enough for the greedy grouping
        // to find several tags, small enough to stay one cheap query.
        let pool_size = (max_mixes * mix_size * 3).min(600) as u32;
        let pool = self.pick_forgotten_favorites(pool_size)?;
        if pool.len() < MIN_MIX_TRACKS {
            return Ok(Vec::new());
        }
        let ids: Vec<i64> = pool.iter().map(|t| t.id).collect();
        let mut tags = self.tag_names_for_tracks(&ids)?;
        let pool: Vec<(Track, Vec<String>)> = pool
            .into_iter()
            .map(|t| {
                let names = tags.remove(&t.id).unwrap_or_default();
                (t, names)
            })
            .collect();
        Ok(group_by_tag(&pool, max_mixes, mix_size))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: i64, artist_id: i64) -> Track {
        Track {
            id,
            path: format!("file:///t{id}.mp3"),
            title: format!("T{id}"),
            artist_id: Some(artist_id),
            artist_name: Some(format!("A{artist_id}")),
            album_id: Some(id),
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
        }
    }

    fn pool(spec: &[(i64, i64, &[&str])]) -> Vec<(Track, Vec<String>)> {
        spec.iter()
            .map(|(id, artist, tags)| (track(*id, *artist), tags.iter().map(|s| s.to_string()).collect()))
            .collect()
    }

    fn ids(m: &TrackMix) -> Vec<i64> {
        m.tracks.iter().map(|t| t.id).collect()
    }

    #[test]
    fn biggest_tag_becomes_the_first_mix_and_tracks_are_not_reused() {
        // 8 jazz (one also rock), 6 rock: jazz leads, rock still fills without
        // the shared track.
        let mut spec: Vec<(i64, i64, &[&str])> = (1..=7).map(|i| (i, i, &["Jazz"][..])).collect();
        spec.push((8, 8, &["Jazz", "Rock"][..]));
        spec.extend((9..=14).map(|i| (i, i, &["Rock"][..])));
        let mixes = group_by_tag(&pool(&spec), 5, 20);
        assert_eq!(mixes[0].tag.as_deref(), Some("Jazz"));
        assert_eq!(ids(&mixes[0]), (1..=8).collect::<Vec<_>>());
        assert_eq!(mixes[1].tag.as_deref(), Some("Rock"));
        assert_eq!(ids(&mixes[1]), (9..=14).collect::<Vec<_>>());
    }

    #[test]
    fn tags_compare_case_insensitively_and_keep_the_first_spelling() {
        let spec: Vec<(i64, i64, &[&str])> = (1..=6)
            .map(|i| (i, i, if i % 2 == 0 { &["hip-hop"][..] } else { &["Hip-Hop"][..] }))
            .collect();
        let mixes = group_by_tag(&pool(&spec), 3, 20);
        assert_eq!(mixes.len(), 1);
        assert_eq!(mixes[0].tag.as_deref(), Some("Hip-Hop"));
        assert_eq!(mixes[0].tracks.len(), 6);
    }

    #[test]
    fn a_tag_too_small_for_a_mix_falls_into_the_catch_all() {
        let mut spec: Vec<(i64, i64, &[&str])> = (1..=4).map(|i| (i, i, &["Folk"][..])).collect();
        spec.extend((5..=8).map(|i| (i, i, &[][..])));
        let mixes = group_by_tag(&pool(&spec), 3, 20);
        assert_eq!(mixes.len(), 1);
        assert_eq!(mixes[0].tag, None);
        assert_eq!(mixes[0].tracks.len(), 8);
    }

    #[test]
    fn caps_tracks_per_artist_inside_a_mix() {
        // 10 tracks by one artist + 6 by others, all "Pop".
        let mut spec: Vec<(i64, i64, &[&str])> = (1..=10).map(|i| (i, 1, &["Pop"][..])).collect();
        spec.extend((11..=16).map(|i| (i, i, &["Pop"][..])));
        let mixes = group_by_tag(&pool(&spec), 1, 20);
        let by_one = mixes[0].tracks.iter().filter(|t| t.artist_id == Some(1)).count();
        assert_eq!(by_one, MIX_MAX_PER_ARTIST);
        assert_eq!(mixes[0].tracks.len(), MIX_MAX_PER_ARTIST + 6);
    }

    #[test]
    fn respects_mix_count_and_size() {
        let spec: Vec<(i64, i64, &[&str])> = (1..=60)
            .map(|i| (i, i, if i <= 30 { &["A"][..] } else { &["B"][..] }))
            .collect();
        let mixes = group_by_tag(&pool(&spec), 1, 10);
        assert_eq!(mixes.len(), 1);
        assert_eq!(mixes[0].tracks.len(), 10);
    }

    #[test]
    fn too_small_a_pool_yields_nothing() {
        let spec: Vec<(i64, i64, &[&str])> = (1..=3).map(|i| (i, i, &["X"][..])).collect();
        assert!(group_by_tag(&pool(&spec), 3, 20).is_empty());
    }
}
