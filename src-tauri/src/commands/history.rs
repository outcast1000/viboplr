// Auto-split from commands.rs. See commands/mod.rs for shared types & helpers.
use super::*;

// --- Play history commands ---

#[tauri::command]
pub fn record_play(state: State<'_, AppState>, title: String, artist_name: Option<String>) -> Result<(), String> {
    state.db.record_play_by_metadata(&title, artist_name.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_history_recent(state: State<'_, AppState>, limit: i64) -> Result<Vec<HistoryEntry>, String> {
    state.db.get_history_recent(limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_history_play_count(state: State<'_, AppState>) -> Result<i64, String> {
    state.db.get_history_play_count().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_history_plays_page(
    state: State<'_, AppState>,
    before_ts: Option<i64>,
    before_id: Option<i64>,
    limit: i64,
) -> Result<Vec<HistoryPlayLite>, String> {
    state.db.get_history_plays_page(before_ts, before_id, limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_history_most_played(state: State<'_, AppState>, limit: i64) -> Result<Vec<HistoryMostPlayed>, String> {
    state.db.get_history_most_played(limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_history_most_played_since(state: State<'_, AppState>, since_ts: i64, limit: i64) -> Result<Vec<HistoryMostPlayed>, String> {
    state.db.get_history_most_played_since(since_ts, limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_history_most_played_artists(state: State<'_, AppState>, limit: i64) -> Result<Vec<HistoryArtistStats>, String> {
    state.db.get_history_most_played_artists(limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_history_most_played_artists_since(state: State<'_, AppState>, since_ts: i64, limit: i64) -> Result<Vec<HistoryArtistStats>, String> {
    state.db.get_history_most_played_artists_since(since_ts, limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_history_artists(state: State<'_, AppState>, query: String, limit: i64) -> Result<Vec<HistoryArtistStats>, String> {
    state.db.search_history_artists(&query, limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_history_tracks(state: State<'_, AppState>, query: String, limit: i64) -> Result<Vec<HistoryMostPlayed>, String> {
    state.db.search_history_tracks(&query, limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reconnect_history_track(state: State<'_, AppState>, history_track_id: i64) -> Result<Option<Track>, String> {
    state.db.reconnect_history_track(history_track_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reconnect_history_artist(state: State<'_, AppState>, history_artist_id: i64) -> Result<Option<i64>, String> {
    state.db.reconnect_history_artist(history_artist_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_track_rank(state: State<'_, AppState>, title: String, artist_name: Option<String>) -> Result<Option<i64>, String> {
    state.db.get_track_rank(&title, artist_name.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_artist_rank(state: State<'_, AppState>, artist_name: String) -> Result<Option<i64>, String> {
    state.db.get_artist_rank(&artist_name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_track_play_history(state: State<'_, AppState>, title: String, artist_name: Option<String>, limit: i64) -> Result<Vec<TrackPlayEntry>, String> {
    state.db.get_track_play_history(&title, artist_name.as_deref(), limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_track_play_stats(state: State<'_, AppState>, title: String, artist_name: Option<String>) -> Result<Option<TrackPlayStats>, String> {
    state.db.get_track_play_stats(&title, artist_name.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_auto_continue_track(
    state: State<'_, AppState>,
    strategy: String,
    current_title: String,
    current_artist: Option<String>,
    format_filter: Option<String>,
) -> Result<Option<Track>, String> {
    state
        .db
        .get_auto_continue_track(&strategy, &current_title, current_artist.as_deref(), format_filter.as_deref(), &[])
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn build_radio_for_track(
    state: State<'_, AppState>,
    seed_title: String,
    seed_artist: Option<String>,
    target_count: u32,
) -> Result<Vec<Track>, String> {
    state
        .db
        .build_radio_for_track(&seed_title, seed_artist.as_deref(), target_count)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pick_radio_seeds(
    state: State<'_, AppState>,
    count: u32,
) -> Result<Vec<Track>, String> {
    state.db.pick_radio_seeds(count).map_err(|e| e.to_string())
}
