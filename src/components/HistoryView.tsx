import { useEffect, useState, forwardRef, useImperativeHandle, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, HistoryEntry, HistoryMostPlayed, HistoryArtistStats } from "../types";

export interface HistoryViewHandle {
  count: number;
  playItem(index: number): void;
  enqueueItem(index: number): void;
}

interface HistoryViewProps {
  searchQuery: string;
  highlightedIndex: number;
  onPlayTrack: (tracks: Track[], index: number) => void;
  onEnqueueTrack: (tracks: Track[]) => void;
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

function matchesQuery(q: string, title: string, artist: string | null): boolean {
  const lower = q.toLowerCase();
  return title.toLowerCase().includes(lower) || (artist?.toLowerCase().includes(lower) ?? false);
}

export const HistoryView = forwardRef<HistoryViewHandle, HistoryViewProps>(
  function HistoryView({ searchQuery, highlightedIndex, onPlayTrack, onEnqueueTrack }, ref) {
  const [mostPlayedAllTime, setMostPlayedAllTime] = useState<HistoryMostPlayed[]>([]);
  const [mostPlayedRecent, setMostPlayedRecent] = useState<HistoryMostPlayed[]>([]);
  const [recentPlays, setRecentPlays] = useState<HistoryEntry[]>([]);
  const [topArtists, setTopArtists] = useState<HistoryArtistStats[]>([]);

  useEffect(() => {
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;
    Promise.all([
      invoke<HistoryMostPlayed[]>("get_history_most_played", { limit: 20 }),
      invoke<HistoryMostPlayed[]>("get_history_most_played_since", { sinceTs: thirtyDaysAgo, limit: 20 }),
      invoke<HistoryEntry[]>("get_history_recent", { limit: 50 }),
      invoke<HistoryArtistStats[]>("get_history_most_played_artists", { limit: 20 }),
    ]).then(([allTime, recent, history, artists]) => {
      setMostPlayedAllTime(allTime);
      setMostPlayedRecent(recent);
      setRecentPlays(history);
      setTopArtists(artists);
    }).catch(console.error);
  }, []);

  const q = searchQuery.trim();
  const filteredAllTime = mostPlayedAllTime
    .map((t, i) => ({ ...t, rank: i + 1 }))
    .filter(t => !q || matchesQuery(q, t.display_title, t.display_artist));
  const filteredRecent30 = mostPlayedRecent
    .map((t, i) => ({ ...t, rank: i + 1 }))
    .filter(t => !q || matchesQuery(q, t.display_title, t.display_artist));
  const filteredPlays = q ? recentPlays.filter(t => matchesQuery(q, t.display_title, t.display_artist)) : recentPlays;
  const filteredArtists = topArtists
    .map((a, i) => ({ ...a, rank: i + 1 }))
    .filter(a => !q || a.display_name.toLowerCase().includes(q.toLowerCase()));

  const flatItems = useMemo(() => {
    const items: (number | null)[] = [];
    for (const t of filteredAllTime) items.push(t.library_track_id);
    for (const t of filteredRecent30) items.push(t.library_track_id);
    for (const t of filteredPlays) items.push(t.library_track_id);
    return items;
  }, [filteredAllTime, filteredRecent30, filteredPlays]);

  async function playTrackById(libraryTrackId: number | null) {
    if (libraryTrackId == null) return;
    try {
      const track = await invoke<Track>("get_track_by_id", { trackId: libraryTrackId });
      onPlayTrack([track], 0);
    } catch (e) {
      console.error("Failed to play track:", e);
    }
  }

  async function enqueueTrackById(libraryTrackId: number | null) {
    if (libraryTrackId == null) return;
    try {
      const track = await invoke<Track>("get_track_by_id", { trackId: libraryTrackId });
      onEnqueueTrack([track]);
    } catch (e) {
      console.error("Failed to enqueue track:", e);
    }
  }

  useImperativeHandle(ref, () => ({
    count: flatItems.length,
    playItem(index: number) {
      if (index >= 0 && index < flatItems.length) {
        playTrackById(flatItems[index]);
      }
    },
    enqueueItem(index: number) {
      if (index >= 0 && index < flatItems.length) {
        enqueueTrackById(flatItems[index]);
      }
    },
  }), [flatItems]);

  let flatIndex = 0;

  function nextFlatIndex() {
    return flatIndex++;
  }

  return (
    <div className="history-view">
      {filteredArtists.length > 0 && (
        <div className="history-section">
          <div className="section-title">Most Played Artists</div>
          <div className="history-list">
            {filteredArtists.map((a) => (
              <div
                key={`artist-${a.history_artist_id}`}
                className={`history-row${a.library_artist_id == null ? " ghost" : ""}`}
              >
                <span className="history-rank">{a.rank}</span>
                <div className="history-info">
                  <span className="history-title">{a.display_name}</span>
                  <span className="history-artist">{a.track_count} track{a.track_count !== 1 ? "s" : ""}</span>
                </div>
                {a.library_artist_id == null && <span className="history-ghost-label">Removed</span>}
                <span className="history-play-count">{a.play_count} play{a.play_count !== 1 ? "s" : ""}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {filteredAllTime.length > 0 && (
        <div className="history-section">
          <div className="section-title">Most Played — All Time</div>
          <div className="history-list">
            {filteredAllTime.map((t) => {
              const idx = nextFlatIndex();
              return (
                <div
                  key={`alltime-${t.history_track_id}`}
                  className={`history-row${idx === highlightedIndex ? " highlighted" : ""}${t.library_track_id == null ? " ghost" : ""}`}
                  data-history-index={idx}
                  onClick={() => playTrackById(t.library_track_id)}
                >
                  <span className="history-rank">{t.rank}</span>
                  <div className="history-info">
                    <span className="history-title">{t.display_title}</span>
                    <span className="history-artist">{t.display_artist ?? "Unknown"}</span>
                  </div>
                  {t.library_track_id == null && <span className="history-ghost-label">Removed</span>}
                  <span className="history-play-count">{t.play_count} play{t.play_count !== 1 ? "s" : ""}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {filteredRecent30.length > 0 && (
        <div className="history-section">
          <div className="section-title">Most Played — Last 30 Days</div>
          <div className="history-list">
            {filteredRecent30.map((t) => {
              const idx = nextFlatIndex();
              return (
                <div
                  key={`recent30-${t.history_track_id}`}
                  className={`history-row${idx === highlightedIndex ? " highlighted" : ""}${t.library_track_id == null ? " ghost" : ""}`}
                  data-history-index={idx}
                  onClick={() => playTrackById(t.library_track_id)}
                >
                  <span className="history-rank">{t.rank}</span>
                  <div className="history-info">
                    <span className="history-title">{t.display_title}</span>
                    <span className="history-artist">{t.display_artist ?? "Unknown"}</span>
                  </div>
                  {t.library_track_id == null && <span className="history-ghost-label">Removed</span>}
                  <span className="history-play-count">{t.play_count} play{t.play_count !== 1 ? "s" : ""}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="history-section">
        <div className="section-title">Recent History</div>
        <div className="history-list">
          {filteredPlays.map((entry) => {
            const idx = nextFlatIndex();
            return (
              <div
                key={entry.id}
                className={`history-row${idx === highlightedIndex ? " highlighted" : ""}${entry.library_track_id == null ? " ghost" : ""}`}
                data-history-index={idx}
                onClick={() => playTrackById(entry.library_track_id)}
              >
                <span className="history-time">{formatRelativeTime(entry.played_at)}</span>
                <div className="history-info">
                  <span className="history-title">{entry.display_title}</span>
                  <span className="history-artist">{entry.display_artist ?? "Unknown"}</span>
                </div>
                {entry.library_track_id == null && <span className="history-ghost-label">Removed</span>}
              </div>
            );
          })}
          {filteredPlays.length === 0 && (
            <div className="empty">No play history yet. Start listening to build your history.</div>
          )}
        </div>
      </div>
    </div>
  );
});
