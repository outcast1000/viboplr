import { useEffect, useState, useRef, useCallback, forwardRef, useImperativeHandle, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Track, HistoryEntry, HistoryMostPlayed, HistoryArtistStats } from "../types";
import "./HistoryView.css";

export interface HistoryViewHandle {
  count: number;
  playItem(index: number): void;
  enqueueItem(index: number): void;
  reload(): void;
}

type HistoryTab = "recent" | "tracks" | "artists";
type Timespan = "30-days" | "year" | "all-time";

interface HistoryViewProps {
  searchQuery: string;
  highlightedIndex: number;
  onPlayTrack: (tracks: Track[], index: number) => void;
  onEnqueueTrack: (tracks: Track[]) => void;
  onArtistClick: (artistId: number, name?: string) => void;
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

function HistoryArt({ imagePath }: { imagePath: string | null | undefined }) {
  if (imagePath) {
    return <img className="history-art" src={convertFileSrc(imagePath)} alt="" />;
  }
  return <div className="history-art history-art-placeholder" />;
}

const TIMESPAN_OPTIONS: { key: Timespan; label: string }[] = [
  { key: "30-days", label: "30 days" },
  { key: "year", label: "Year" },
  { key: "all-time", label: "All time" },
];

function timespanSinceTs(ts: Timespan): number | null {
  if (ts === "all-time") return null;
  const days = ts === "30-days" ? 30 : 365;
  return Math.floor(Date.now() / 1000) - days * 86400;
}

export const HistoryView = forwardRef<HistoryViewHandle, HistoryViewProps>(
  function HistoryView({ searchQuery, highlightedIndex, onPlayTrack, onEnqueueTrack, onArtistClick }, ref) {
  const [activeTab, setActiveTab] = useState<HistoryTab>("recent");
  const [tracksTimespan, setTracksTimespan] = useState<Timespan>("30-days");
  const [artistsTimespan, setArtistsTimespan] = useState<Timespan>("30-days");

  const [recentPlays, setRecentPlays] = useState<HistoryEntry[]>([]);
  // Cached datasets keyed by timespan so toggling is instant after the first fetch.
  const [tracksByTimespan, setTracksByTimespan] = useState<Partial<Record<Timespan, HistoryMostPlayed[]>>>({});
  const [artistsByTimespan, setArtistsByTimespan] = useState<Partial<Record<Timespan, HistoryArtistStats[]>>>({});

  // Local artist image cache keyed by display name
  const [artistImages, setArtistImages] = useState<Record<string, string | null>>({});
  const artistImageFetched = useRef(new Set<string>());

  const fetchArtistImage = useCallback((name: string) => {
    if (artistImages[name] !== undefined) return;
    if (artistImageFetched.current.has(name)) return;
    artistImageFetched.current = new Set(artistImageFetched.current).add(name);
    invoke<string | null>("get_entity_image", { kind: "artist", name }).then((path) => {
      if (path) {
        setArtistImages((prev) => ({ ...prev, [name]: path }));
      }
    });
  }, [artistImages]);

  const fetchTracks = useCallback((ts: Timespan) => {
    const sinceTs = timespanSinceTs(ts);
    const promise = sinceTs == null
      ? invoke<HistoryMostPlayed[]>("get_history_most_played", { limit: 100 })
      : invoke<HistoryMostPlayed[]>("get_history_most_played_since", { sinceTs, limit: 100 });
    promise
      .then((tracks) => setTracksByTimespan((prev) => ({ ...prev, [ts]: tracks })))
      .catch((e) => console.error("Failed to load tracks history:", e));
  }, []);

  const fetchArtists = useCallback((ts: Timespan) => {
    const sinceTs = timespanSinceTs(ts);
    const promise = sinceTs == null
      ? invoke<HistoryArtistStats[]>("get_history_most_played_artists", { limit: 100 })
      : invoke<HistoryArtistStats[]>("get_history_most_played_artists_since", { sinceTs, limit: 100 });
    promise
      .then((artists) => setArtistsByTimespan((prev) => ({ ...prev, [ts]: artists })))
      .catch((e) => console.error("Failed to load artists history:", e));
  }, []);

  const fetchRecent = useCallback(() => {
    invoke<HistoryEntry[]>("get_history_recent", { limit: 100 })
      .then(setRecentPlays)
      .catch((e) => console.error("Failed to load recent history:", e));
  }, []);

  const reloadAll = useCallback(() => {
    fetchRecent();
    fetchTracks(tracksTimespan);
    fetchArtists(artistsTimespan);
  }, [fetchRecent, fetchTracks, fetchArtists, tracksTimespan, artistsTimespan]);

  // Initial load: only the active tab's data; other tabs lazy-load on switch.
  useEffect(() => { fetchRecent(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy-fetch when the user switches tabs or changes timespan.
  useEffect(() => {
    if (activeTab === "tracks" && !tracksByTimespan[tracksTimespan]) {
      fetchTracks(tracksTimespan);
    }
  }, [activeTab, tracksTimespan, tracksByTimespan, fetchTracks]);

  useEffect(() => {
    if (activeTab === "artists" && !artistsByTimespan[artistsTimespan]) {
      fetchArtists(artistsTimespan);
    }
  }, [activeTab, artistsTimespan, artistsByTimespan, fetchArtists]);

  // Server-side search when query is active
  const [searchedArtists, setSearchedArtists] = useState<HistoryArtistStats[] | null>(null);
  const [searchedTracks, setSearchedTracks] = useState<HistoryMostPlayed[] | null>(null);

  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchedArtists(null);
      setSearchedTracks(null);
      return;
    }
    const timer = setTimeout(() => {
      Promise.all([
        invoke<HistoryArtistStats[]>("search_history_artists", { query: q, limit: 50 }),
        invoke<HistoryMostPlayed[]>("search_history_tracks", { query: q, limit: 50 }),
      ]).then(([artists, tracks]) => {
        setSearchedArtists(artists);
        setSearchedTracks(tracks);
      }).catch(console.error);
    }, 200);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const q = searchQuery.trim();

  const currentTracks = tracksByTimespan[tracksTimespan];
  const currentArtists = artistsByTimespan[artistsTimespan];

  // Fetch artist images for all unique artist names visible
  useEffect(() => {
    const names = new Set<string>();
    if (searchedArtists) for (const a of searchedArtists) names.add(a.display_name);
    if (searchedTracks) for (const t of searchedTracks) if (t.display_artist) names.add(t.display_artist);
    if (currentArtists) for (const a of currentArtists) names.add(a.display_name);
    if (currentTracks) for (const t of currentTracks) if (t.display_artist) names.add(t.display_artist);
    for (const t of recentPlays) if (t.display_artist) names.add(t.display_artist);
    for (const name of names) fetchArtistImage(name);
  }, [searchedArtists, searchedTracks, currentArtists, currentTracks, recentPlays, fetchArtistImage]);

  // Determine what is visible
  const visibleTracks: HistoryMostPlayed[] | null = (() => {
    if (q) return searchedTracks; // search overrides tabs
    if (activeTab === "tracks") return currentTracks ?? [];
    return null;
  })();

  const visibleArtists: HistoryArtistStats[] | null = (() => {
    if (q) return searchedArtists;
    if (activeTab === "artists") return currentArtists ?? [];
    return null;
  })();

  const visibleRecent: HistoryEntry[] | null = (() => {
    if (q) return null;
    if (activeTab === "recent") return recentPlays;
    return null;
  })();

  const flatItems = useMemo(() => {
    const items: { historyTrackId: number }[] = [];
    if (visibleTracks) {
      for (const t of visibleTracks) items.push({ historyTrackId: t.history_track_id });
    }
    if (visibleRecent) {
      for (const t of visibleRecent) items.push({ historyTrackId: t.history_track_id });
    }
    return items;
  }, [visibleTracks, visibleRecent]);

  async function playTrackById(historyTrackId: number) {
    try {
      const track = await invoke<Track | null>("reconnect_history_track", { historyTrackId });
      if (track) {
        onPlayTrack([track], 0);
      }
    } catch (e) {
      console.error("Failed to reconnect track:", e);
    }
  }

  async function enqueueTrackById(historyTrackId: number) {
    try {
      const track = await invoke<Track | null>("reconnect_history_track", { historyTrackId });
      if (track) {
        onEnqueueTrack([track]);
      }
    } catch (e) {
      console.error("Failed to reconnect track:", e);
    }
  }

  async function handleArtistDoubleClick(historyArtistId: number) {
    try {
      const artistId = await invoke<number | null>("reconnect_history_artist", { historyArtistId });
      if (artistId) {
        onArtistClick(artistId);
      }
    } catch (e) {
      console.error("Failed to reconnect artist:", e);
    }
  }

  const tabs: { key: HistoryTab; label: string }[] = [
    { key: "recent", label: "Recent" },
    { key: "tracks", label: "Tracks" },
    { key: "artists", label: "Artists" },
  ];

  useImperativeHandle(ref, () => ({
    count: flatItems.length,
    playItem(index: number) {
      if (index >= 0 && index < flatItems.length) {
        const item = flatItems[index];
        playTrackById(item.historyTrackId);
      }
    },
    enqueueItem(index: number) {
      if (index >= 0 && index < flatItems.length) {
        const item = flatItems[index];
        enqueueTrackById(item.historyTrackId);
      }
    },
    reload: reloadAll,
  }), [flatItems, reloadAll]);

  let flatIndex = 0;
  function nextFlatIndex() { return flatIndex++; }

  const showTimespan = !q && (activeTab === "tracks" || activeTab === "artists");
  const currentTimespan = activeTab === "tracks" ? tracksTimespan : artistsTimespan;
  const setCurrentTimespan = (ts: Timespan) => {
    if (activeTab === "tracks") setTracksTimespan(ts);
    else if (activeTab === "artists") setArtistsTimespan(ts);
  };

  return (
    <div className="history-view">
      {!q && (
        <div className="history-toolbar">
          <div className="ds-tabs">
            {tabs.map(tab => (
              <button
                key={tab.key}
                className={`ds-tab${activeTab === tab.key ? " active" : ""}`}
                onClick={() => setActiveTab(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {showTimespan && (
            <div className="history-timespan">
              {TIMESPAN_OPTIONS.map(opt => (
                <button
                  key={opt.key}
                  className={`ds-btn ds-btn--ghost ds-btn--sm${currentTimespan === opt.key ? " active" : ""}`}
                  onClick={() => setCurrentTimespan(opt.key)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="history-content">
        {/* Search results: artists */}
        {q && visibleArtists && visibleArtists.length > 0 && (
          <div className="history-section">
            <div className="section-title">Artists</div>
            <div className="history-list">
              {visibleArtists.map((a) => (
                <div
                  key={`artist-${a.history_artist_id}`}
                  className="history-row"
                  onDoubleClick={() => handleArtistDoubleClick(a.history_artist_id)}
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

        {/* Search results: tracks */}
        {q && visibleTracks && visibleTracks.length > 0 && (
          <div className="history-section">
            <div className="section-title">Tracks</div>
            <div className="history-list">
              {visibleTracks.map((t) => {
                const idx = nextFlatIndex();
                return (
                  <div
                    key={`search-${t.history_track_id}`}
                    className={`history-row${idx === highlightedIndex ? " highlighted" : ""}`}
                    data-history-index={idx}
                    onDoubleClick={() => playTrackById(t.history_track_id)}
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

        {/* Tab: Recent */}
        {!q && activeTab === "recent" && (
          <div className="history-section">
            <div className="history-list">
              {recentPlays.map((entry) => {
                const idx = nextFlatIndex();
                return (
                  <div
                    key={entry.id}
                    className={`history-row${idx === highlightedIndex ? " highlighted" : ""}`}
                    data-history-index={idx}
                    onDoubleClick={() => playTrackById(entry.history_track_id)}
                  >
                    <HistoryArt imagePath={entry.display_artist ? artistImages[entry.display_artist] : null} />
                    <div className="history-info">
                      <span className="history-title">{entry.display_title}</span>
                      <span className="history-artist">{entry.display_artist ?? "Unknown"} &middot; {formatRelativeTime(entry.played_at)}</span>
                    </div>
                  </div>
                );
              })}
              {recentPlays.length === 0 && (
                <div className="empty">No play history yet. Start listening to build your history.</div>
              )}
            </div>
          </div>
        )}

        {/* Tab: Tracks */}
        {!q && activeTab === "tracks" && (
          <div className="history-section">
            <div className="history-list">
              {(currentTracks ?? []).map((t) => {
                const idx = nextFlatIndex();
                return (
                  <div
                    key={`tracks-${tracksTimespan}-${t.history_track_id}`}
                    className={`history-row${idx === highlightedIndex ? " highlighted" : ""}`}
                    data-history-index={idx}
                    onDoubleClick={() => playTrackById(t.history_track_id)}
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
              {currentTracks && currentTracks.length === 0 && (
                <div className="empty">No tracks in this timespan.</div>
              )}
            </div>
          </div>
        )}

        {/* Tab: Artists */}
        {!q && activeTab === "artists" && (
          <div className="history-section">
            <div className="history-list">
              {(currentArtists ?? []).map((a) => (
                <div
                  key={`artists-${artistsTimespan}-${a.history_artist_id}`}
                  className="history-row"
                  onDoubleClick={() => handleArtistDoubleClick(a.history_artist_id)}
                >
                  <span className="history-rank">{a.rank}</span>
                  <HistoryArt imagePath={artistImages[a.display_name]} />
                  <div className="history-info">
                    <span className="history-title">{a.display_name}</span>
                    <span className="history-artist">{a.play_count} play{a.play_count !== 1 ? "s" : ""} &middot; {a.track_count} track{a.track_count !== 1 ? "s" : ""}</span>
                  </div>
                </div>
              ))}
              {currentArtists && currentArtists.length === 0 && (
                <div className="empty">No artists in this timespan.</div>
              )}
            </div>
          </div>
        )}

        {/* Search: no results */}
        {q && (!visibleTracks || visibleTracks.length === 0) && (!visibleArtists || visibleArtists.length === 0) && (
          <div className="empty">No history matching "{searchQuery}"</div>
        )}
      </div>
    </div>
  );
});
