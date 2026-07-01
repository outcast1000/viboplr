import { useEffect, useState, useRef, useCallback, forwardRef, useImperativeHandle, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, HistoryEntry, HistoryMostPlayed, HistoryArtistStats } from "../types";
import type { ContextMenuTarget } from "../types/contextMenu";
import { isLocalTrack } from "../queueEntry";
import { resolveImageUrl } from "../utils/resolveImageUrl";
import { TrackRow } from "./TrackRow";
// Index-based multi-select over the currently-visible rows (string keys so
// tracks and artists can share one ordered list). The prefixed keys are built
// by the parent; the algorithm itself is the shared generic.
import { computeSelection as computeKeySelection } from "../utils/rowSelection";
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
  onLocateTrack: (track: Track) => void;
  onArtistClick: (artistId: number, name?: string) => void;
  onPlayArtist: (artistId: number) => void;
  onEnqueueArtist: (artistId: number) => void;
  onStartRadio?: (seed: { title: string; artistName: string | null; coverPath: string | null }) => void;
  onShowContextMenu?: (x: number, y: number, target: ContextMenuTarget) => void;
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

// A history entry — track OR artist — rendered via the shared TrackRow. The row
// is entity-agnostic (rank in the leading slot, artist-only art with a blank
// placeholder, plays/relative-time in the subtitle); selection/keyboard/ghost
// logic stays in the parent, which passes `selected`/`active` + bound actions.
function HistoryRow({
  selected, active, dataIndex, rank, imagePath, title, subtitle,
  onClick, onContextMenu, onDoubleClick, onPlay, onEnqueue, onStartRadio, onDetails,
}: {
  selected: boolean;
  active?: boolean;
  dataIndex?: number;
  rank?: number;
  imagePath: string | null | undefined;
  title: string;
  subtitle: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onPlay: () => void;
  onEnqueue: () => void;
  onStartRadio?: () => void;   // track rows only (artists have no radio seed)
  onDetails: () => void;
}) {
  return (
    <TrackRow
      selected={selected}
      active={active}
      dataAttrs={dataIndex != null ? { "data-history-index": dataIndex } : undefined}
      leading={rank != null ? <span className="history-rank">{rank}</span> : undefined}
      thumb={imagePath ? { kind: "image", url: resolveImageUrl(imagePath) ?? "" } : { kind: "blank" }}
      title={title}
      subtitle={subtitle}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      actions={{ onPlay, onEnqueue, onStartRadio, onDetails }}
    />
  );
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
  function HistoryView({ searchQuery, highlightedIndex, onPlayTrack, onEnqueueTrack, onLocateTrack, onArtistClick, onPlayArtist, onEnqueueArtist, onStartRadio, onShowContextMenu }, ref) {
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
    // resolveAlbums:false — the History view never renders the album, so skip the
    // O(library) album resolution that otherwise froze this query on open.
    invoke<HistoryEntry[]>("get_history_recent", { limit: 100, resolveAlbums: false })
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

  // --- Multi-select + native context menu over the visible rows ---
  // Keys use distinct prefixes per list so the same track/artist showing in two
  // lists doesn't cross-highlight. Recent keys by play-row id (a track can recur);
  // the others key by entity id. Search lists use sa:/st: to stay distinct.
  type RowMeta = { kind: "track" | "artist"; histId: number; title: string; artist: string | null };
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const lastClickIndexRef = useRef<number | null>(null);

  const rowMetaByKey = useMemo(() => {
    const m = new Map<string, RowMeta>();
    if (visibleArtists) for (const a of visibleArtists) m.set(`${q ? "sa" : "a"}:${a.history_artist_id}`, { kind: "artist", histId: a.history_artist_id, title: a.display_name, artist: null });
    if (visibleTracks) for (const t of visibleTracks) m.set(`${q ? "st" : "t"}:${t.history_track_id}`, { kind: "track", histId: t.history_track_id, title: t.display_title, artist: t.display_artist ?? null });
    if (visibleRecent) for (const e of visibleRecent) m.set(`r:${e.id}`, { kind: "track", histId: e.history_track_id, title: e.display_title, artist: e.display_artist ?? null });
    return m;
  }, [visibleArtists, visibleTracks, visibleRecent, q]);

  const orderedKeys = useMemo(() => {
    const keys: string[] = [];
    if (q) {
      if (visibleArtists) for (const a of visibleArtists) keys.push(`sa:${a.history_artist_id}`);
      if (visibleTracks) for (const t of visibleTracks) keys.push(`st:${t.history_track_id}`);
    } else if (visibleRecent) {
      for (const e of visibleRecent) keys.push(`r:${e.id}`);
    } else if (visibleTracks) {
      for (const t of visibleTracks) keys.push(`t:${t.history_track_id}`);
    } else if (visibleArtists) {
      for (const a of visibleArtists) keys.push(`a:${a.history_artist_id}`);
    }
    return keys;
  }, [q, visibleArtists, visibleTracks, visibleRecent]);

  const orderedIndex = useMemo(() => {
    const m = new Map<string, number>();
    orderedKeys.forEach((k, i) => m.set(k, i));
    return m;
  }, [orderedKeys]);

  // Clear selection whenever the visible set changes (tab / timespan / search).
  useEffect(() => { setSelectedKeys(new Set()); lastClickIndexRef.current = null; }, [activeTab, tracksTimespan, artistsTimespan, q]);

  const handleRowClick = useCallback((e: React.MouseEvent, key: string) => {
    const idx = orderedIndex.get(key);
    if (idx == null) return;
    setSelectedKeys(prev => computeKeySelection(prev, idx, orderedKeys, lastClickIndexRef.current, e.metaKey || e.ctrlKey, e.shiftKey));
    lastClickIndexRef.current = idx;
  }, [orderedIndex, orderedKeys]);

  const reconnectTrackById = useCallback(async (historyTrackId: number): Promise<Track | null> => {
    try { return await invoke<Track | null>("reconnect_history_track", { historyTrackId }); }
    catch (e) { console.error("Failed to reconnect track:", e); return null; }
  }, []);

  const reconnectArtistById = useCallback(async (historyArtistId: number): Promise<number | null> => {
    try { return await invoke<number | null>("reconnect_history_artist", { historyArtistId }); }
    catch (e) { console.error("Failed to reconnect artist:", e); return null; }
  }, []);

  // The history row carries no library id, so a target is resolved on demand by
  // reconnecting the history row to a real track/artist (same path as play).
  const showSingleMenu = useCallback(async (key: string, x: number, y: number) => {
    const meta = rowMetaByKey.get(key);
    if (!meta || !onShowContextMenu) return;
    if (meta.kind === "artist") {
      const artistId = await reconnectArtistById(meta.histId);
      onShowContextMenu(x, y, { kind: "artist", artistId: artistId ?? undefined, name: meta.title });
    } else {
      const track = await reconnectTrackById(meta.histId);
      if (track) onShowContextMenu(x, y, { kind: "track", trackId: track.id ?? undefined, isLocal: isLocalTrack(track), title: track.title, artistName: track.artist_name });
      else onShowContextMenu(x, y, { kind: "track", title: meta.title, artistName: meta.artist });
    }
  }, [rowMetaByKey, onShowContextMenu, reconnectArtistById, reconnectTrackById]);

  const handleRowContextMenu = useCallback((e: React.MouseEvent, key: string) => {
    e.preventDefault();
    if (!onShowContextMenu) return;
    const x = e.clientX, y = e.clientY;
    // Right-click outside the current selection collapses to just that row.
    let sel = selectedKeys;
    if (!sel.has(key)) {
      sel = new Set([key]);
      setSelectedKeys(sel);
      lastClickIndexRef.current = orderedIndex.get(key) ?? null;
    }
    if (sel.size <= 1) { void showSingleMenu(key, x, y); return; }
    const metas = [...sel].map(k => rowMetaByKey.get(k)).filter((m): m is RowMeta => !!m);
    const tracks = metas.filter(m => m.kind === "track");
    const artists = metas.filter(m => m.kind === "artist");
    // A mixed track+artist selection has no single sensible target — act on the clicked row.
    if (tracks.length && artists.length) { void showSingleMenu(key, x, y); return; }
    (async () => {
      if (artists.length) {
        const ids = (await Promise.all(artists.map(a => reconnectArtistById(a.histId)))).filter((id): id is number => id != null);
        if (ids.length) onShowContextMenu(x, y, { kind: "multi-artist", artistIds: ids });
      } else {
        const ids = (await Promise.all(tracks.map(t => reconnectTrackById(t.histId).then(tr => tr?.id ?? null)))).filter((id): id is number => id != null);
        if (ids.length) onShowContextMenu(x, y, { kind: "multi-track", trackIds: ids });
      }
    })();
  }, [onShowContextMenu, selectedKeys, orderedIndex, rowMetaByKey, showSingleMenu, reconnectArtistById, reconnectTrackById]);

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

  async function detailsTrackById(historyTrackId: number) {
    try {
      const track = await invoke<Track | null>("reconnect_history_track", { historyTrackId });
      if (track) {
        onLocateTrack(track);
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

  async function playArtistById(historyArtistId: number) {
    try {
      const artistId = await invoke<number | null>("reconnect_history_artist", { historyArtistId });
      if (artistId) {
        onPlayArtist(artistId);
      }
    } catch (e) {
      console.error("Failed to reconnect artist:", e);
    }
  }

  async function enqueueArtistById(historyArtistId: number) {
    try {
      const artistId = await invoke<number | null>("reconnect_history_artist", { historyArtistId });
      if (artistId) {
        onEnqueueArtist(artistId);
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
              {visibleArtists.map((a) => {
                const selKey = `sa:${a.history_artist_id}`;
                return (
                <HistoryRow
                  key={`artist-${a.history_artist_id}`}
                  selected={selectedKeys.has(selKey)}
                  rank={a.rank}
                  imagePath={artistImages[a.display_name]}
                  title={a.display_name}
                  subtitle={<>{a.play_count} play{a.play_count !== 1 ? "s" : ""} &middot; {a.track_count} track{a.track_count !== 1 ? "s" : ""}</>}
                  onClick={(e) => handleRowClick(e, selKey)}
                  onContextMenu={(e) => handleRowContextMenu(e, selKey)}
                  onDoubleClick={() => handleArtistDoubleClick(a.history_artist_id)}
                  onPlay={() => playArtistById(a.history_artist_id)}
                  onEnqueue={() => enqueueArtistById(a.history_artist_id)}
                  onDetails={() => handleArtistDoubleClick(a.history_artist_id)}
                />
                );
              })}
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
                const selKey = `st:${t.history_track_id}`;
                return (
                  <HistoryRow
                    key={`search-${t.history_track_id}`}
                    selected={selectedKeys.has(selKey)}
                    active={idx === highlightedIndex}
                    dataIndex={idx}
                    rank={t.rank}
                    imagePath={t.display_artist ? artistImages[t.display_artist] : null}
                    title={t.display_title}
                    subtitle={<>{t.display_artist ?? "Unknown"} &middot; {t.play_count} play{t.play_count !== 1 ? "s" : ""}</>}
                    onClick={(e) => handleRowClick(e, selKey)}
                    onContextMenu={(e) => handleRowContextMenu(e, selKey)}
                    onDoubleClick={() => playTrackById(t.history_track_id)}
                    onPlay={() => playTrackById(t.history_track_id)}
                    onEnqueue={() => enqueueTrackById(t.history_track_id)}
                    onStartRadio={onStartRadio ? () => onStartRadio({ title: t.display_title, artistName: t.display_artist ?? null, coverPath: t.display_artist ? artistImages[t.display_artist] ?? null : null }) : undefined}
                    onDetails={() => detailsTrackById(t.history_track_id)}
                  />
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
                const selKey = `r:${entry.id}`;
                return (
                  <HistoryRow
                    key={entry.id}
                    selected={selectedKeys.has(selKey)}
                    active={idx === highlightedIndex}
                    dataIndex={idx}
                    imagePath={entry.display_artist ? artistImages[entry.display_artist] : null}
                    title={entry.display_title}
                    subtitle={<>{entry.display_artist ?? "Unknown"} &middot; {formatRelativeTime(entry.played_at)}</>}
                    onClick={(e) => handleRowClick(e, selKey)}
                    onContextMenu={(e) => handleRowContextMenu(e, selKey)}
                    onDoubleClick={() => playTrackById(entry.history_track_id)}
                    onPlay={() => playTrackById(entry.history_track_id)}
                    onEnqueue={() => enqueueTrackById(entry.history_track_id)}
                    onStartRadio={onStartRadio ? () => onStartRadio({ title: entry.display_title, artistName: entry.display_artist ?? null, coverPath: entry.display_artist ? artistImages[entry.display_artist] ?? null : null }) : undefined}
                    onDetails={() => detailsTrackById(entry.history_track_id)}
                  />
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
                const selKey = `t:${t.history_track_id}`;
                return (
                  <HistoryRow
                    key={`tracks-${tracksTimespan}-${t.history_track_id}`}
                    selected={selectedKeys.has(selKey)}
                    active={idx === highlightedIndex}
                    dataIndex={idx}
                    rank={t.rank}
                    imagePath={t.display_artist ? artistImages[t.display_artist] : null}
                    title={t.display_title}
                    subtitle={<>{t.display_artist ?? "Unknown"} &middot; {t.play_count} play{t.play_count !== 1 ? "s" : ""}</>}
                    onClick={(e) => handleRowClick(e, selKey)}
                    onContextMenu={(e) => handleRowContextMenu(e, selKey)}
                    onDoubleClick={() => playTrackById(t.history_track_id)}
                    onPlay={() => playTrackById(t.history_track_id)}
                    onEnqueue={() => enqueueTrackById(t.history_track_id)}
                    onStartRadio={onStartRadio ? () => onStartRadio({ title: t.display_title, artistName: t.display_artist ?? null, coverPath: t.display_artist ? artistImages[t.display_artist] ?? null : null }) : undefined}
                    onDetails={() => detailsTrackById(t.history_track_id)}
                  />
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
              {(currentArtists ?? []).map((a) => {
                const selKey = `a:${a.history_artist_id}`;
                return (
                <HistoryRow
                  key={`artists-${artistsTimespan}-${a.history_artist_id}`}
                  selected={selectedKeys.has(selKey)}
                  rank={a.rank}
                  imagePath={artistImages[a.display_name]}
                  title={a.display_name}
                  subtitle={<>{a.play_count} play{a.play_count !== 1 ? "s" : ""} &middot; {a.track_count} track{a.track_count !== 1 ? "s" : ""}</>}
                  onClick={(e) => handleRowClick(e, selKey)}
                  onContextMenu={(e) => handleRowContextMenu(e, selKey)}
                  onDoubleClick={() => handleArtistDoubleClick(a.history_artist_id)}
                  onPlay={() => playArtistById(a.history_artist_id)}
                  onEnqueue={() => enqueueArtistById(a.history_artist_id)}
                  onDetails={() => handleArtistDoubleClick(a.history_artist_id)}
                />
                );
              })}
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
