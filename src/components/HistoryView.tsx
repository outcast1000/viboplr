import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, PlayHistoryEntry, MostPlayedTrack } from "../types";

interface HistoryViewProps {
  searchQuery: string;
  onPlayTrack: (tracks: Track[], index: number) => void;
}

function formatRelativeTime(unixSecs: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - unixSecs;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unixSecs * 1000).toLocaleDateString();
}

function formatDuration(secs: number | null): string {
  if (secs === null) return "";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function matchesQuery(q: string, title: string, artist: string | null): boolean {
  const lower = q.toLowerCase();
  return title.toLowerCase().includes(lower) || (artist?.toLowerCase().includes(lower) ?? false);
}

export function HistoryView({ searchQuery, onPlayTrack }: HistoryViewProps) {
  const [mostPlayedAllTime, setMostPlayedAllTime] = useState<MostPlayedTrack[]>([]);
  const [mostPlayedRecent, setMostPlayedRecent] = useState<MostPlayedTrack[]>([]);
  const [recentPlays, setRecentPlays] = useState<PlayHistoryEntry[]>([]);

  useEffect(() => {
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;
    Promise.all([
      invoke<MostPlayedTrack[]>("get_most_played", { limit: 20 }),
      invoke<MostPlayedTrack[]>("get_most_played_since", { sinceTs: thirtyDaysAgo, limit: 20 }),
      invoke<PlayHistoryEntry[]>("get_recent_plays", { limit: 50 }),
    ]).then(([allTime, recent, history]) => {
      setMostPlayedAllTime(allTime);
      setMostPlayedRecent(recent);
      setRecentPlays(history);
    }).catch(console.error);
  }, []);

  const q = searchQuery.trim();
  const filteredAllTime = mostPlayedAllTime
    .map((t, i) => ({ ...t, rank: i + 1 }))
    .filter(t => !q || matchesQuery(q, t.track_title, t.artist_name));
  const filteredRecent30 = mostPlayedRecent
    .map((t, i) => ({ ...t, rank: i + 1 }))
    .filter(t => !q || matchesQuery(q, t.track_title, t.artist_name));
  const filteredPlays = q ? recentPlays.filter(t => matchesQuery(q, t.track_title, t.artist_name)) : recentPlays;

  async function handleClick(trackId: number) {
    try {
      const track = await invoke<Track>("get_track_by_id", { trackId });
      onPlayTrack([track], 0);
    } catch (e) {
      console.error("Failed to play track:", e);
    }
  }

  return (
    <div className="history-view">
      {filteredAllTime.length > 0 && (
        <div className="history-section">
          <div className="section-title">Most Played — All Time</div>
          <div className="history-list">
            {filteredAllTime.map((t) => (
              <div key={t.track_id} className="history-row" onClick={() => handleClick(t.track_id)}>
                <span className="history-rank">{t.rank}</span>
                <div className="history-info">
                  <span className="history-title">{t.track_title}</span>
                  <span className="history-artist">{t.artist_name ?? "Unknown"}</span>
                </div>
                <span className="history-duration">{formatDuration(t.duration_secs)}</span>
                <span className="history-play-count">{t.play_count} play{t.play_count !== 1 ? "s" : ""}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {filteredRecent30.length > 0 && (
        <div className="history-section">
          <div className="section-title">Most Played — Last 30 Days</div>
          <div className="history-list">
            {filteredRecent30.map((t) => (
              <div key={t.track_id} className="history-row" onClick={() => handleClick(t.track_id)}>
                <span className="history-rank">{t.rank}</span>
                <div className="history-info">
                  <span className="history-title">{t.track_title}</span>
                  <span className="history-artist">{t.artist_name ?? "Unknown"}</span>
                </div>
                <span className="history-duration">{formatDuration(t.duration_secs)}</span>
                <span className="history-play-count">{t.play_count} play{t.play_count !== 1 ? "s" : ""}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="history-section">
        <div className="section-title">Recent History</div>
        <div className="history-list">
          {filteredPlays.map((entry) => (
            <div key={entry.id} className="history-row" onClick={() => handleClick(entry.track_id)}>
              <span className="history-time">{formatRelativeTime(entry.played_at)}</span>
              <div className="history-info">
                <span className="history-title">{entry.track_title}</span>
                <span className="history-artist">{entry.artist_name ?? "Unknown"}</span>
              </div>
              <span className="history-duration">{formatDuration(entry.duration_secs)}</span>
            </div>
          ))}
          {filteredPlays.length === 0 && (
            <div className="empty">No play history yet. Start listening to build your history.</div>
          )}
        </div>
      </div>
    </div>
  );
}
