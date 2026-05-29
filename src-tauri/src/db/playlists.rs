// Auto-split from db.rs. Shared types/helpers live in db/mod.rs;
// these are inherent `impl Database` methods reachable via `use super::*`.
use super::*;

impl Database {

    // --- Playlists ---

    pub fn save_playlist(&self, name: &str, source: Option<&str>, image_path: Option<&str>, description: Option<&str>, metadata: Option<&str>) -> SqlResult<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO playlists (name, source, image_path, description, metadata) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![name, source, image_path, description, metadata],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn save_playlist_tracks(
        &self,
        playlist_id: i64,
        tracks: &[(&str, Option<&str>, Option<&str>, Option<f64>, Option<&str>, Option<&str>)],
    ) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "INSERT INTO playlist_tracks (playlist_id, position, title, artist_name, album_name, duration_secs, source, image_path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
        )?;
        for (i, (title, artist, album, duration, source, image)) in tracks.iter().enumerate() {
            stmt.execute(params![playlist_id, i as i64, title, artist, album, duration, source, image])?;
        }
        Ok(())
    }

    pub fn get_playlists(&self) -> SqlResult<Vec<Playlist>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT p.id, p.name, p.source, p.saved_at, p.image_path,
                    (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = p.id) as track_count,
                    p.description, p.metadata
             FROM playlists p ORDER BY p.saved_at DESC"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Playlist {
                id: row.get(0)?,
                name: row.get(1)?,
                source: row.get(2)?,
                saved_at: row.get(3)?,
                image_path: row.get(4)?,
                track_count: row.get(5)?,
                description: row.get(6)?,
                metadata: row.get(7)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_playlist_tracks(&self, playlist_id: i64) -> SqlResult<Vec<PlaylistTrack>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, playlist_id, position, title, artist_name, album_name, duration_secs, source, image_path
             FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position"
        )?;
        let rows = stmt.query_map(params![playlist_id], |row| {
            Ok(PlaylistTrack {
                id: row.get(0)?,
                playlist_id: row.get(1)?,
                position: row.get(2)?,
                title: row.get(3)?,
                artist_name: row.get(4)?,
                album_name: row.get(5)?,
                duration_secs: row.get(6)?,
                source: row.get(7)?,
                image_path: row.get(8)?,
            })
        })?;
        rows.collect()
    }

    pub fn delete_playlist(&self, playlist_id: i64) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM playlists WHERE id = ?1", params![playlist_id])?;
        Ok(())
    }

    pub fn update_playlist_image(&self, playlist_id: i64, image_path: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE playlists SET image_path = ?1 WHERE id = ?2",
            params![image_path, playlist_id],
        )?;
        Ok(())
    }

    pub fn update_playlist_track_image(&self, track_id: i64, image_path: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE playlist_tracks SET image_path = ?1 WHERE id = ?2",
            params![image_path, track_id],
        )?;
        Ok(())
    }
}
