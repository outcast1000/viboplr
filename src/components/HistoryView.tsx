import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, PlayHistoryEntry, MostPlayedTrack } from "../types";

interface HistoryViewProps {
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

export function HistoryView({ onPlayTrack }: HistoryViewProps) {
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
      {mostPlayedAllTime.length > 0 && (
        <div className="history-section">
          <div className="section-title">Most Played — All Time</div>
          <div className="history-list">
            {mostPlayedAllTime.map((t, i) => (
              <div key={t.track_id} className="history-row" onClick={() => handleClick(t.track_id)}>
                <span className="history-rank">{i + 1}</span>
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

      {mostPlayedRecent.length > 0 && (
        <div className="history-section">
          <div className="section-title">Most Played — Last 30 Days</div>
          <div className="history-list">
            {mostPlayedRecent.map((t, i) => (
              <div key={t.track_id} className="history-row" onClick={() => handleClick(t.track_id)}>
                <span className="history-rank">{i + 1}</span>
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
          {recentPlays.map((entry) => (
            <div key={entry.id} className="history-row" onClick={() => handleClick(entry.track_id)}>
              <span className="history-time">{formatRelativeTime(entry.played_at)}</span>
              <div className="history-info">
                <span className="history-title">{entry.track_title}</span>
                <span className="history-artist">{entry.artist_name ?? "Unknown"}</span>
              </div>
              <span className="history-duration">{formatDuration(entry.duration_secs)}</span>
            </div>
          ))}
          {recentPlays.length === 0 && (
            <div className="empty">No play history yet. Start listening to build your history.</div>
          )}
        </div>
      </div>
    </div>
  );
}
