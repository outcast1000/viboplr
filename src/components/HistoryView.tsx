import { useEffect, useState, useRef, useCallback, forwardRef, useImperativeHandle, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
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
  addLog: (message: string) => void;
  onArtistClick: (artistId: number) => void;
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

function HistoryArt({ imagePath }: { imagePath: string | null | undefined }) {
  if (imagePath) {
    return <img className="history-art" src={convertFileSrc(imagePath)} alt="" />;
  }
  return <div className="history-art history-art-placeholder" />;
}

export const HistoryView = forwardRef<HistoryViewHandle, HistoryViewProps>(
  function HistoryView({ searchQuery, highlightedIndex, onPlayTrack, onEnqueueTrack, addLog, onArtistClick }, ref) {
  const [mostPlayedAllTime, setMostPlayedAllTime] = useState<HistoryMostPlayed[]>([]);
  const [mostPlayedRecent, setMostPlayedRecent] = useState<HistoryMostPlayed[]>([]);
  const [recentPlays, setRecentPlays] = useState<HistoryEntry[]>([]);
  const [topArtists, setTopArtists] = useState<HistoryArtistStats[]>([]);

  // Local artist image cache keyed by display name
  const [artistImages, setArtistImages] = useState<Record<string, string | null>>({});
  const artistImageFetched = useRef(new Set<string>());

  const fetchArtistImage = useCallback((name: string) => {
    if (artistImages[name] !== undefined) return;
    if (artistImageFetched.current.has(name)) return;
    artistImageFetched.current = new Set(artistImageFetched.current).add(name);
    invoke<string | null>("get_entity_image_by_name", { kind: "artist", name }).then((path) => {
      if (path) {
        setArtistImages((prev) => ({ ...prev, [name]: path }));
      }
    });
  }, [artistImages]);

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

  // Fetch artist images for all unique artist names
  useEffect(() => {
    const names = new Set<string>();
    for (const a of topArtists) names.add(a.display_name);
    for (const t of mostPlayedAllTime) if (t.display_artist) names.add(t.display_artist);
    for (const t of mostPlayedRecent) if (t.display_artist) names.add(t.display_artist);
    for (const t of recentPlays) if (t.display_artist) names.add(t.display_artist);
    for (const name of names) fetchArtistImage(name);
  }, [topArtists, mostPlayedAllTime, mostPlayedRecent, recentPlays]);

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
    const items: { libraryTrackId: number | null; historyTrackId: number }[] = [];
    for (const t of filteredAllTime) items.push({ libraryTrackId: t.library_track_id, historyTrackId: t.history_track_id });
    for (const t of filteredRecent30) items.push({ libraryTrackId: t.library_track_id, historyTrackId: t.history_track_id });
    for (const t of filteredPlays) items.push({ libraryTrackId: t.library_track_id, historyTrackId: t.history_track_id });
    return items;
  }, [filteredAllTime, filteredRecent30, filteredPlays]);

  async function playTrackById(libraryTrackId: number | null, historyTrackId: number) {
    if (libraryTrackId != null) {
      try {
        const track = await invoke<Track>("get_track_by_id", { trackId: libraryTrackId });
        onPlayTrack([track], 0);
      } catch (e) {
        console.error("Failed to play track:", e);
      }
      return;
    }
    try {
      const track = await invoke<Track | null>("reconnect_history_track", { historyTrackId });
      if (track) {
        onPlayTrack([track], 0);
      } else {
        addLog("Track not found in library \u2014 it may have been removed");
      }
    } catch (e) {
      console.error("Failed to reconnect track:", e);
      addLog("Track not found in library \u2014 it may have been removed");
    }
  }

  async function enqueueTrackById(libraryTrackId: number | null, historyTrackId: number) {
    if (libraryTrackId != null) {
      try {
        const track = await invoke<Track>("get_track_by_id", { trackId: libraryTrackId });
        onEnqueueTrack([track]);
      } catch (e) {
        console.error("Failed to enqueue track:", e);
      }
      return;
    }
    try {
      const track = await invoke<Track | null>("reconnect_history_track", { historyTrackId });
      if (track) {
        onEnqueueTrack([track]);
      } else {
        addLog("Track not found in library \u2014 it may have been removed");
      }
    } catch (e) {
      console.error("Failed to reconnect track:", e);
      addLog("Track not found in library \u2014 it may have been removed");
    }
  }

  async function handleArtistDoubleClick(libraryArtistId: number | null, historyArtistId: number) {
    if (libraryArtistId != null) {
      onArtistClick(libraryArtistId);
      return;
    }
    try {
      const artistId = await invoke<number | null>("reconnect_history_artist", { historyArtistId });
      if (artistId) {
        onArtistClick(artistId);
      } else {
        addLog("Artist not found in library \u2014 they may have been removed");
      }
    } catch (e) {
      console.error("Failed to reconnect artist:", e);
      addLog("Artist not found in library \u2014 they may have been removed");
    }
  }

  useImperativeHandle(ref, () => ({
    count: flatItems.length,
    playItem(index: number) {
      if (index >= 0 && index < flatItems.length) {
        const item = flatItems[index];
        playTrackById(item.libraryTrackId, item.historyTrackId);
      }
    },
    enqueueItem(index: number) {
      if (index >= 0 && index < flatItems.length) {
        const item = flatItems[index];
        enqueueTrackById(item.libraryTrackId, item.historyTrackId);
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
                className="history-row"
                onDoubleClick={() => handleArtistDoubleClick(a.library_artist_id, a.history_artist_id)}
              >
                <span className="history-rank">{a.rank}</span>
                <HistoryArt imagePath={artistImages[a.display_name]} />
                <div className="history-info">
                  <span className="history-title">{a.display_name}</span>
                  <span className="history-artist">{a.play_count} play{a.play_count !== 1 ? "s" : ""} &middot; {a.track_count} track{a.track_count !== 1 ? "s" : ""}</span>
                </div>
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
                  className={`history-row${idx === highlightedIndex ? " highlighted" : ""}`}
                  data-history-index={idx}
                  onDoubleClick={() => playTrackById(t.library_track_id, t.history_track_id)}
                >
                  <span className="history-rank">{t.rank}</span>
                  <HistoryArt imagePath={t.display_artist ? artistImages[t.display_artist] : null} />
                  <div className="history-info">
                    <span className="history-title">{t.display_title}</span>
                    <span className="history-artist">{t.display_artist ?? "Unknown"} &middot; {t.play_count} play{t.play_count !== 1 ? "s" : ""}</span>
                  </div>
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
                  className={`history-row${idx === highlightedIndex ? " highlighted" : ""}`}
                  data-history-index={idx}
                  onDoubleClick={() => playTrackById(t.library_track_id, t.history_track_id)}
                >
                  <span className="history-rank">{t.rank}</span>
                  <HistoryArt imagePath={t.display_artist ? artistImages[t.display_artist] : null} />
                  <div className="history-info">
                    <span className="history-title">{t.display_title}</span>
                    <span className="history-artist">{t.display_artist ?? "Unknown"} &middot; {t.play_count} play{t.play_count !== 1 ? "s" : ""}</span>
                  </div>
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
                className={`history-row${idx === highlightedIndex ? " highlighted" : ""}`}
                data-history-index={idx}
                onDoubleClick={() => playTrackById(entry.library_track_id, entry.history_track_id)}
              >
                <HistoryArt imagePath={entry.display_artist ? artistImages[entry.display_artist] : null} />
                <div className="history-info">
                  <span className="history-title">{entry.display_title}</span>
                  <span className="history-artist">{entry.display_artist ?? "Unknown"} &middot; {formatRelativeTime(entry.played_at)}</span>
                </div>
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
