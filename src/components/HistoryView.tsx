// The History view, laid out like the Library (SearchView): its own search box,
// tabs with counts (Plays · Tracks · Artists — the first, id "recent", is the
// play log), one range for every tab shown in the tab bar, a collapsible sort
// bar, and the three view modes (table / list / tiles) over paged rows. The
// search narrows every tab at once, as in the Library.
//
// History rows aren't library tracks: they are name-keyed plays, and a play can
// outlive its file (a "ghost"). The backend matches each row to a library copy
// (`display_track_id` / `display_path` / album / length), so a row plays,
// highlights, drags and opens its links without a reconnect round-trip; a ghost
// plays through the stream resolvers by name (`historyQueueTrack`). An artist
// row plays the library artist when the library has tracks by them, and
// otherwise their songs from history (`history_artist_tracks`), so no row is a
// dead end.
import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Artist, QueueTrack, HistoryEntry, HistoryMostPlayed, HistoryArtistStats, HistoryPage, ViewMode } from "../types";
import type { ContextMenuTarget } from "../types/contextMenu";
import type { Notify } from "../hooks/useToasts";
import { isLocalTrack } from "../queueEntry";
import { formatDuration, formatRelativeTime, formatDateTime } from "../utils";
import { resolveImageUrl } from "../utils/resolveImageUrl";
import { useImageCache } from "../hooks/useImageCache";
import { pickEntityImagePath, resolveTrackImage } from "../utils/trackImage";
import { useQueueVideoFrames, shelfVideoKey } from "../hooks/useShelfVideoFrames";
import { useLatestRef } from "../hooks/useLatestRef";
import { store } from "../store";
import { trackLikeKey } from "../likeKeys";
import { toggleSortKey, chainDir, type SortKey } from "../sortChain";
import { computeSelection as computeKeySelection } from "../utils/rowSelection";
import {
  coerceHistorySettings, rangeSinceTs, historyQueueTrack, playsLabel,
  DEFAULT_HISTORY_SETTINGS, HISTORY_RANGES, HISTORY_PAGE_SIZE, HISTORY_TABS,
  type HistorySettings, type HistoryTab, type HistoryRange, type HistoryTrackFields,
} from "../utils/historyView";
import { TrackRow } from "./TrackRow";
import { TrackCard } from "./TrackCard";
import { RowHoverActions } from "./RowHoverActions";
import { LikeDislikeButtons } from "./LikeDislikeButtons";
import { EntityArtFallback } from "./EntityArtFallback";
import { ViewModeToggle } from "./ViewModeToggle";
import { SortButton, LoadMoreSentinel } from "./search/searchShared";
import "./TrackList.css";
import "./HistoryView.css";

interface HistoryViewProps {
  /** The query lives in App (`viewSearch`), so it survives leaving the view. */
  query: string;
  onQueryChange: (q: string) => void;
  currentTrack: QueueTrack | null;
  onPlayTracks: (tracks: QueueTrack[], index: number) => void;
  onEnqueueTracks: (tracks: QueueTrack[]) => void;
  /** Open the track page of a library row (the copy the history row plays). */
  onLocateTrackId: (trackId: number) => void;
  onLocateTrackByName: (title: string, artistName?: string, albumTitle?: string) => void;
  onArtistClick: (artistId: number, name?: string) => void;
  onAlbumClick: (albumId: number, artistId?: number | null, name?: string, artistName?: string) => void;
  /** Resolve with whether anything was queued (an artist may have no tracks). */
  onPlayArtist: (artistId: number) => Promise<boolean>;
  onEnqueueArtist: (artistId: number) => Promise<boolean>;
  onStartRadio?: (seed: { title: string; artistName: string | null; coverPath: string | null }) => void;
  onShowContextMenu?: (x: number, y: number, target: ContextMenuTarget) => void;
  onToggleLike: (track: QueueTrack) => void;
  onToggleDislike: (track: QueueTrack) => void;
  onTrackDragStart: (tracks: QueueTrack[]) => void;
  onNotify: Notify;
}

type TrackLikeRow = HistoryEntry | HistoryMostPlayed;

/** How many of an artist's history songs their row's Play queues. */
const HISTORY_ARTIST_TRACKS_LIMIT = 200;
type AnyRow = TrackLikeRow | HistoryArtistStats;

interface TabData<T> {
  rows: T[];
  total: number;
  /** Rows the backend has handed over, repeats included — the next offset. */
  fetched: number;
  hasMore: boolean;
  loadingMore: boolean;
  /** Rows (or an error) are in for the tab's current list. */
  loaded: boolean;
  error: string | null;
  /** The window start and the cutoff the first page was read with; every
   *  later page reuses them so the pages describe one list. */
  sinceTs: number | null;
  asOf: number | null;
}
const EMPTY_TAB = { rows: [], total: 0, fetched: 0, hasMore: false, loadingMore: false, loaded: false, error: null, sinceTs: null, asOf: null };

const TAB_LABELS: Record<HistoryTab, string> = { recent: "Plays", tracks: "Tracks", artists: "Artists" };

const PAGE_COMMANDS: Record<HistoryTab, string> = {
  recent: "history_recent_page",
  tracks: "history_tracks_page",
  artists: "history_artists_page",
};

// Sort-bar buttons per tab; field names are the backend's whitelist
// (db/history.rs RECENT/TRACK/ARTIST_SORT_FIELDS).
const SORT_BUTTONS: Record<HistoryTab, { label: string; field: string }[]> = {
  recent: [{ label: "Played", field: "played" }, { label: "Title", field: "title" }, { label: "Artist", field: "artist" }, { label: "Plays", field: "plays" }],
  tracks: [{ label: "Plays", field: "plays" }, { label: "Title", field: "title" }, { label: "Artist", field: "artist" }, { label: "Last played", field: "played" }],
  artists: [{ label: "Plays", field: "plays" }, { label: "Name", field: "name" }, { label: "Tracks", field: "tracks" }, { label: "Last played", field: "played" }],
};

// Clicks on these land on a control inside the row, not on the row.
const ROW_CONTROL_SELECTOR = ".track-link, .col-like, .like-dislike, .album-card-menu-btn, .ds-card-play, .row-hover-action, .album-card-art-wrapper";

function rowKey(tab: HistoryTab, r: AnyRow): string {
  if (tab === "recent") return `r:${(r as HistoryEntry).id}`;
  if (tab === "tracks") return `t:${(r as HistoryMostPlayed).history_track_id}`;
  return `a:${(r as HistoryArtistStats).history_artist_id}`;
}

export function HistoryView({
  query, onQueryChange, currentTrack,
  onPlayTracks, onEnqueueTracks, onLocateTrackId, onLocateTrackByName,
  onArtistClick, onAlbumClick, onPlayArtist, onEnqueueArtist, onStartRadio,
  onShowContextMenu, onToggleLike, onToggleDislike, onTrackDragStart, onNotify,
}: HistoryViewProps) {
  const [settings, setSettings] = useState<HistorySettings>(DEFAULT_HISTORY_SETTINGS);
  const [restored, setRestored] = useState(false);
  const { activeTab, sortChains, range, viewModes, sortBarCollapsed } = settings;
  const viewMode = viewModes[activeTab];

  const [recent, setRecent] = useState<TabData<HistoryEntry>>(EMPTY_TAB);
  const [tracks, setTracks] = useState<TabData<HistoryMostPlayed>>(EMPTY_TAB);
  const [artists, setArtists] = useState<TabData<HistoryArtistStats>>(EMPTY_TAB);

  const [debouncedQuery, setDebouncedQuery] = useState(query.trim());
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);

  // --- settings: restored once, saved on every change after that ---
  useEffect(() => {
    store.get<unknown>("historySettings")
      .then(saved => setSettings(coerceHistorySettings(saved)))
      .catch(e => console.error("Failed to restore history settings:", e))
      .finally(() => setRestored(true));
  }, []);
  useEffect(() => {
    if (!restored) return;
    store.set("historySettings", settings).catch(e => console.error("Failed to save history settings:", e));
  }, [settings, restored]);

  const update = useCallback((patch: (s: HistorySettings) => HistorySettings) => setSettings(patch), []);
  const setTab = (tab: HistoryTab) => update(s => ({ ...s, activeTab: tab }));
  const setViewMode = (mode: ViewMode) => update(s => ({ ...s, viewModes: { ...s.viewModes, [s.activeTab]: mode } }));
  const setRange = (r: HistoryRange) => update(s => ({ ...s, range: r }));
  const setSortChain = (chain: SortKey[]) => update(s => ({ ...s, sortChains: { ...s.sortChains, [s.activeTab]: chain } }));
  const handleSort = (field: string, e?: { shiftKey: boolean }) =>
    setSortChain(toggleSortKey(sortChains[activeTab], field, !!e?.shiftKey));

  // --- data: one paged query per tab; a generation per tab drops stale pages ---
  const genRef = useRef<Record<HistoryTab, number>>({ recent: 0, tracks: 0, artists: 0 });
  const setters = useMemo(() => ({
    recent: setRecent as React.Dispatch<React.SetStateAction<TabData<AnyRow>>>,
    tracks: setTracks as React.Dispatch<React.SetStateAction<TabData<AnyRow>>>,
    artists: setArtists as React.Dispatch<React.SetStateAction<TabData<AnyRow>>>,
  }), []);

  // What decides a tab's list. A change reloads that tab; the query is in all
  // three, so typing reloads every badge.
  const listKeys = useMemo<Record<HistoryTab, string>>(() => {
    const k = (tab: HistoryTab) => `${debouncedQuery}|${range}|${JSON.stringify(sortChains[tab])}`;
    return { recent: k("recent"), tracks: k("tracks"), artists: k("artists") };
  }, [debouncedQuery, range, sortChains]);

  /** Load a tab's first page, or — for a tab not on screen — only its total
   *  (`limit: 0`), for the badge; its rows come when it is opened. The window
   *  start and the cutoff are fixed here, for every later page of this list. */
  const loadTab = useCallback((tab: HistoryTab, full: boolean) => {
    const gen = ++genRef.current[tab];
    const sinceTs = rangeSinceTs(range);
    const asOf = Math.floor(Date.now() / 1000);
    invoke<HistoryPage<AnyRow>>(PAGE_COMMANDS[tab], {
      query: debouncedQuery || null,
      sinceTs,
      asOf,
      sortChain: sortChains[tab].length > 0 ? sortChains[tab] : null,
      offset: 0,
      limit: full ? HISTORY_PAGE_SIZE : 0,
    })
      .then(page => {
        if (genRef.current[tab] !== gen) return;
        setters[tab](full
          ? { ...EMPTY_TAB, rows: page.rows, total: page.total, fetched: page.rows.length, hasMore: page.rows.length < page.total, loaded: true, sinceTs, asOf }
          : { ...EMPTY_TAB, total: page.total });
      })
      .catch(e => {
        console.error(`Failed to load history (${tab}):`, e);
        if (genRef.current[tab] !== gen) return;
        if (!full) return; // a badge goes missing; the tab reports it when opened
        setters[tab]({ ...EMPTY_TAB, loaded: true, error: String(e) });
        onNotify("Couldn't load your history", { kind: "error" });
      });
  }, [debouncedQuery, range, sortChains, setters, onNotify]);

  // What each tab last asked for, so a re-run of the effect below only loads
  // what changed: a tab whose list moved, or a counted tab that was opened.
  const requestedRef = useRef<Record<HistoryTab, { key: string; full: boolean } | null>>({ recent: null, tracks: null, artists: null });
  useEffect(() => {
    if (!restored) return;
    for (const tab of HISTORY_TABS) {
      const full = tab === activeTab;
      const req = requestedRef.current[tab];
      if (req && req.key === listKeys[tab] && (req.full || !full)) continue;
      requestedRef.current[tab] = { key: listKeys[tab], full };
      loadTab(tab, full);
    }
  }, [restored, activeTab, listKeys, loadTab]);

  const retry = () => {
    requestedRef.current[activeTab] = { key: listKeys[activeTab], full: true };
    loadTab(activeTab, true);
  };

  const data: Record<HistoryTab, TabData<AnyRow>> = { recent, tracks, artists };
  const current = data[activeTab];

  const loadMore = () => {
    const tab = activeTab;
    const d = data[tab];
    if (!d.hasMore || d.loadingMore || !d.loaded) return;
    const gen = genRef.current[tab];
    setters[tab](prev => ({ ...prev, loadingMore: true }));
    invoke<HistoryPage<AnyRow>>(PAGE_COMMANDS[tab], {
      query: debouncedQuery || null,
      sinceTs: d.sinceTs,
      asOf: d.asOf,
      sortChain: sortChains[tab].length > 0 ? sortChains[tab] : null,
      offset: d.fetched,
      limit: HISTORY_PAGE_SIZE,
    })
      .then(page => {
        if (genRef.current[tab] !== gen) return;
        setters[tab](prev => {
          // The cutoff holds the play log and the windowed rankings still; the
          // all-time rankings read live counters, so a play can still move a
          // row across the page boundary — never show it twice.
          const seen = new Set(prev.rows.map(r => rowKey(tab, r)));
          const rows = [...prev.rows, ...page.rows.filter(r => !seen.has(rowKey(tab, r)))];
          const fetched = prev.fetched + page.rows.length;
          return { ...prev, rows, fetched, total: page.total, hasMore: fetched < page.total && page.rows.length > 0, loadingMore: false };
        });
      })
      .catch(e => {
        console.error(`Failed to load more history (${tab}):`, e);
        if (genRef.current[tab] !== gen) return;
        setters[tab](prev => ({ ...prev, loadingMore: false, hasMore: false }));
        onNotify("Couldn't load more of your history", { kind: "error" });
      });
  };
  // Stable for LoadMoreSentinel (it re-observes when the callback changes);
  // the ref always reaches this render's closure.
  const loadMoreRef = useLatestRef(loadMore);
  const handleLoadMore = useCallback(() => loadMoreRef.current(), [loadMoreRef]);

  // --- images: the shared entity caches (album → artist), plus a video's frame ---
  const albumImages = useImageCache("album");
  const artistImages = useImageCache("artist");
  const entityLookups = useMemo(() => ({
    albumImageFor: albumImages.getImage,
    artistImageFor: artistImages.getImage,
  }), [albumImages, artistImages]);
  const imageMeta = (t: HistoryTrackFields) => ({
    title: t.display_title,
    artist_name: t.display_artist,
    album_title: t.display_album,
    album_artist_name: t.display_album_artist,
  });
  const trackRows = activeTab === "artists" ? [] : (current.rows as TrackLikeRow[]);
  const framePathsKey = trackRows.map(r => r.display_path ?? "").join("\n");
  const frameRows = useMemo(
    () => framePathsKey.split("\n").filter(Boolean).map(path => ({ path })),
    [framePathsKey],
  );
  const videoFrames = useQueueVideoFrames(frameRows);
  const trackImageUrl = (t: TrackLikeRow): string | null =>
    resolveTrackImage(imageMeta(t), { ...entityLookups, videoFrame: videoFrames[shelfVideoKey(t.display_path)] ?? null });
  const trackCoverPath = (t: TrackLikeRow): string | null => pickEntityImagePath(imageMeta(t), entityLookups);
  const artistImageUrl = (name: string): string | null => resolveImageUrl(artistImages.getImage(name)) ?? null;

  // --- what's playing: by song (title + artist), library row or not ---
  const playingKey = currentTrack ? trackLikeKey(currentTrack.title, currentTrack.artist_name) : null;
  const isPlayingRow = (t: TrackLikeRow) => playingKey !== null && trackLikeKey(t.display_title, t.display_artist) === playingKey;

  // --- selection + keyboard cursor over the active tab's rows ---
  const orderedKeys = useMemo(() => current.rows.map(r => rowKey(activeTab, r)), [current.rows, activeTab]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(-1);
  const lastClickRef = useRef<number | null>(null);
  const didDragRef = useRef(false);
  const resultsRef = useRef<HTMLDivElement>(null);

  // A new list (tab, query, sort, range) starts with nothing selected; a page
  // appended at the bottom keeps the selection.
  // Reset with React's previous-value-in-state form (not an effect), so the
  // new list never renders a frame with the old list's selection.
  const listIdentity = `${activeTab}|${listKeys[activeTab]}`;
  const [shownIdentity, setShownIdentity] = useState(listIdentity);
  if (shownIdentity !== listIdentity) {
    setShownIdentity(listIdentity);
    setSelected(new Set());
    setCursor(-1);
  }
  useEffect(() => {
    lastClickRef.current = null;
    if (resultsRef.current) resultsRef.current.scrollTop = 0;
  }, [listIdentity]);

  const selectedRows = <T extends AnyRow>(rows: T[]): T[] =>
    rows.filter(r => selected.has(rowKey(activeTab, r)));

  function handleRowClick(e: React.MouseEvent, index: number) {
    if (didDragRef.current) return;
    if ((e.target as HTMLElement).closest(ROW_CONTROL_SELECTOR)) return;
    setSelected(prev => computeKeySelection(prev, index, orderedKeys, lastClickRef.current, e.metaKey || e.ctrlKey, e.shiftKey));
    lastClickRef.current = index;
    setCursor(index);
  }

  // Cmd/Ctrl+A selects the loaded rows, Escape clears — as in the Library.
  // Not while a modal is up: those keys are the modal's then.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement)?.closest("input, textarea, [contenteditable]")) return;
      if (document.querySelector(".ds-modal-overlay")) return;
      if (e.key === "Escape" && selected.size > 0) setSelected(new Set());
      else if (e.key === "a" && (e.metaKey || e.ctrlKey) && orderedKeys.length > 0) {
        e.preventDefault();
        setSelected(new Set(orderedKeys));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, orderedKeys]);

  // --- actions ---
  const playRows = (rows: TrackLikeRow[], index: number) => {
    setSelected(new Set());
    onPlayTracks(rows.map(historyQueueTrack), index);
  };
  const playOne = (t: TrackLikeRow) => playRows([t], 0);
  const enqueueOne = (t: TrackLikeRow) => onEnqueueTracks([historyQueueTrack(t)]);
  const radioFor = (t: TrackLikeRow) => onStartRadio
    ? () => onStartRadio({ title: t.display_title, artistName: t.display_artist ?? null, coverPath: trackCoverPath(t) })
    : undefined;

  // The row's own library copy — the one it plays — or, for a ghost, the
  // name-only track page.
  function openTrackPage(t: TrackLikeRow) {
    if (t.display_track_id != null) onLocateTrackId(t.display_track_id);
    else onLocateTrackByName(t.display_title, t.display_artist ?? undefined, t.display_album ?? undefined);
  }

  // The library artist a history artist row names, if any — the same lookup
  // as the artist page (`navigateToArtistByName`).
  const findArtistId = useCallback(async (name: string): Promise<number | null> => {
    try { return (await invoke<Artist | null>("find_artist_by_name", { name }))?.id ?? null; }
    catch (e) { console.error("Failed to look up a history artist in the library:", e); return null; }
  }, []);

  // An artist row's Play / Enqueue: the library artist's tracks when the
  // library has any; otherwise that artist's songs from history, most played
  // first, each through its library copy or by name — an artist you only
  // streamed or watched (or one that is only an album artist) still plays.
  const playArtistRow = (a: HistoryArtistStats, enqueue: boolean) => {
    (async () => {
      const id = await findArtistId(a.display_name);
      if (id != null && await (enqueue ? onEnqueueArtist(id) : onPlayArtist(id))) return;
      const rows = await invoke<HistoryMostPlayed[]>("history_artist_tracks", {
        historyArtistId: a.history_artist_id, limit: HISTORY_ARTIST_TRACKS_LIMIT,
      });
      if (rows.length === 0) {
        onNotify(`Nothing to play by ${a.display_name}`, { kind: "warning" });
        return;
      }
      const tracks = rows.map(historyQueueTrack);
      if (enqueue) onEnqueueTracks(tracks);
      else onPlayTracks(tracks, 0);
    })().catch(e => {
      console.error("Failed to play a history artist:", e);
      onNotify(`Couldn't play ${a.display_name}`, { kind: "error" });
    });
  };
  const openArtist = (a: HistoryArtistStats) => onArtistClick(0, a.display_name);
  const openArtistByName = (name: string | null) => { if (name) onArtistClick(0, name); };
  const openAlbum = (t: TrackLikeRow) => {
    if (t.display_album) onAlbumClick(0, null, t.display_album, t.display_album_artist ?? t.display_artist ?? undefined);
  };

  // Right-click outside the selection collapses to that row, as everywhere.
  function handleContextMenu(e: React.MouseEvent, index: number) {
    e.preventDefault();
    if (!onShowContextMenu) return;
    const key = orderedKeys[index];
    let sel = selected;
    if (!sel.has(key)) {
      sel = new Set([key]);
      setSelected(sel);
      lastClickRef.current = index;
    }
    const x = e.clientX, y = e.clientY;
    if (activeTab === "artists") {
      const rows = (current.rows as HistoryArtistStats[]).filter(r => sel.has(rowKey("artists", r)));
      if (rows.length <= 1) {
        const a = current.rows[index] as HistoryArtistStats;
        findArtistId(a.display_name).then(id =>
          onShowContextMenu(x, y, { kind: "artist", artistId: id ?? undefined, name: a.display_name }));
        return;
      }
      // The multi menu is id-based; with none of these artists in the library,
      // the clicked row's own menu opens instead of nothing.
      const a = current.rows[index] as HistoryArtistStats;
      Promise.all(rows.map(r => findArtistId(r.display_name))).then(ids => {
        const artistIds = ids.filter((id): id is number => id != null);
        if (artistIds.length) onShowContextMenu(x, y, { kind: "multi-artist", artistIds });
        else onShowContextMenu(x, y, { kind: "artist", name: a.display_name });
      });
      return;
    }
    const rows = (current.rows as TrackLikeRow[]).filter(r => sel.has(rowKey(activeTab, r)));
    const t = current.rows[index] as TrackLikeRow;
    const showSingle = () => onShowContextMenu(x, y, {
      kind: "track",
      trackId: t.display_track_id ?? undefined,
      isLocal: isLocalTrack({ path: t.display_path }),
      title: t.display_title,
      artistName: t.display_artist,
      albumTitle: t.display_album,
    });
    if (rows.length <= 1) { showSingle(); return; }
    // A multi-track menu acts on library rows; ghost plays have none to name.
    // Each track once — the play log can hold several plays of one song. With
    // none in the library, the clicked row's own menu opens instead of nothing.
    const byId = new Map<number, string | null>();
    for (const r of rows) if (r.display_track_id != null && !byId.has(r.display_track_id)) byId.set(r.display_track_id, r.display_path ?? null);
    if (!byId.size) { showSingle(); return; }
    onShowContextMenu(x, y, {
      kind: "multi-track",
      trackIds: [...byId.keys()],
      tracks: [...byId].map(([id, path]) => ({ id, path })),
    });
  }

  function handleMouseDown(e: React.MouseEvent, index: number) {
    if (e.button !== 0 || activeTab === "artists") return;
    if ((e.target as HTMLElement).closest(ROW_CONTROL_SELECTOR)) return;
    const startX = e.clientX, startY = e.clientY;
    didDragRef.current = false;
    const rows = current.rows as TrackLikeRow[];
    const key = orderedKeys[index];
    const onMove = (ev: MouseEvent) => {
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 5) return;
      didDragRef.current = true;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const dragged = selected.has(key) && selected.size > 1 ? selectedRows(rows) : [rows[index]];
      onTrackDragStart(dragged.map(historyQueueTrack));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setTimeout(() => { didDragRef.current = false; }, 0);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // The search box moves the cursor: ↓/↑ step through the rows, Enter plays the
  // row (or opens the artist), Shift+Enter enqueues it.
  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const n = current.rows.length;
    if (n === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? Math.min(cursor + 1, n - 1) : Math.max(cursor - 1, 0);
      setCursor(next);
      resultsRef.current?.querySelector(`[data-history-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && cursor >= 0 && cursor < n) {
      e.preventDefault();
      const row = current.rows[cursor];
      if (activeTab === "artists") {
        const a = row as HistoryArtistStats;
        if (e.shiftKey) playArtistRow(a, true); else openArtist(a);
      } else if (e.shiftKey) {
        enqueueOne(row as TrackLikeRow);
      } else {
        playOne(row as TrackLikeRow);
      }
    }
  }

  // --- rendering helpers ---
  const sortArrow = (field: string) => {
    const dir = chainDir(sortChains[activeTab], field);
    return dir === "asc" ? "▲" : dir === "desc" ? "▼" : "";
  };
  const header = (label: string, field: string | null, className: string) => (
    <span
      className={`${className}${field ? " sortable" : ""}${field && chainDir(sortChains[activeTab], field) ? " sorted" : ""}`}
      onClick={field ? (e) => handleSort(field, e) : undefined}
    >
      <span className="col-header-label">{label}</span>
      {field && sortArrow(field) && <span className="col-header-sort">{sortArrow(field)}</span>}
    </span>
  );

  const likeFor = (t: TrackLikeRow, variant: "inline" | "overlay" = "inline") => {
    const qt = () => historyQueueTrack(t);
    return (
      <LikeDislikeButtons
        liked={0}
        track={{ title: t.display_title, artist_name: t.display_artist }}
        onToggleLike={() => onToggleLike(qt())}
        onToggleDislike={() => onToggleDislike(qt())}
        variant={variant}
        size={12}
      />
    );
  };

  const artistLink = (name: string | null) => name
    ? <span className="track-link" onClick={(e) => { e.stopPropagation(); openArtistByName(name); }}>{name}</span>
    : <>Unknown</>;
  const albumLink = (t: TrackLikeRow) => t.display_album
    ? <span className="track-link" onClick={(e) => { e.stopPropagation(); openAlbum(t); }}>{t.display_album}</span>
    : null;

  const rowState = (index: number, key: string) => ({
    selected: selected.has(key),
    active: index === cursor,
  });

  const playedTitle = (ts: number | null | undefined) => (ts ? formatDateTime(ts) : undefined);

  function renderTrackTable(rows: TrackLikeRow[]) {
    const isRecent = activeTab === "recent";
    return (
      <div className="track-list history-table" role="listbox" aria-multiselectable="true" aria-label="History">
        <div className="track-header" role="presentation">
          {!isRecent && header("#", null, "col-num")}
          <span className="col-like" />
          {header("Title", "title", "col-title")}
          {header("Artist", "artist", "col-artist")}
          <span className="col-album"><span className="col-header-label">Album</span></span>
          {isRecent ? header("Played", "played", "col-played") : header("Last played", "played", "col-played")}
          {header("Plays", "plays", "col-plays")}
          <span className="col-duration"><span className="col-header-label">Length</span></span>
        </div>
        {rows.map((t, i) => {
          const key = rowKey(activeTab, t);
          const st = rowState(i, key);
          const ts = isRecent ? (t as HistoryEntry).played_at : (t as HistoryMostPlayed).last_played_at;
          const ghost = t.display_track_id == null;
          return (
            <div
              key={key}
              role="option"
              aria-selected={st.selected}
              data-history-index={i}
              className={`track-row${isPlayingRow(t) ? " playing" : ""}${st.active ? " highlighted" : ""}${st.selected ? " selected" : ""}${ghost ? " history-row--ghost" : ""}`}
              onMouseDown={(e) => handleMouseDown(e, i)}
              onClick={(e) => handleRowClick(e, i)}
              onDoubleClick={() => playRows(rows, i)}
              onContextMenu={(e) => handleContextMenu(e, i)}
            >
              {!isRecent && <span className="col-num">{(t as HistoryMostPlayed).rank}</span>}
              <span className="col-like">{likeFor(t)}</span>
              <span className="col-title">
                <span className="col-title-main">
                  <span className="col-title-text" title={t.display_title}>{t.display_title}</span>
                  {ghost && <span className="track-missing-badge">Not in library</span>}
                </span>
                <RowHoverActions onPlay={() => playOne(t)} onEnqueue={() => enqueueOne(t)} onStartRadio={radioFor(t)} onDetails={() => openTrackPage(t)} />
              </span>
              <span className="col-artist">{t.display_artist ? artistLink(t.display_artist) : ""}</span>
              <span className="col-album">{albumLink(t)}</span>
              <span className="col-played" title={playedTitle(ts)}>{ts ? formatRelativeTime(ts) : ""}</span>
              <span className="col-plays">{t.play_count}</span>
              <span className="col-duration">{t.display_duration_secs ? formatDuration(t.display_duration_secs) : ""}</span>
            </div>
          );
        })}
      </div>
    );
  }

  function renderArtistTable(rows: HistoryArtistStats[]) {
    return (
      <div className="track-list history-table" role="listbox" aria-multiselectable="true" aria-label="History artists">
        <div className="track-header" role="presentation">
          <span className="col-num"><span className="col-header-label">#</span></span>
          {header("Name", "name", "col-title")}
          {header("Plays", "plays", "col-plays")}
          {header("Tracks", "tracks", "col-plays")}
          {header("Last played", "played", "col-played")}
        </div>
        {rows.map((a, i) => {
          const key = rowKey("artists", a);
          const st = rowState(i, key);
          return (
            <div
              key={key}
              role="option"
              aria-selected={st.selected}
              data-history-index={i}
              className={`track-row${st.active ? " highlighted" : ""}${st.selected ? " selected" : ""}`}
              onClick={(e) => handleRowClick(e, i)}
              onDoubleClick={() => openArtist(a)}
              onContextMenu={(e) => handleContextMenu(e, i)}
            >
              <span className="col-num">{a.rank}</span>
              <span className="col-title">
                <span className="col-title-main"><span className="col-title-text" title={a.display_name}>{a.display_name}</span></span>
                <RowHoverActions onPlay={() => playArtistRow(a, false)} onEnqueue={() => playArtistRow(a, true)} onDetails={() => openArtist(a)} />
              </span>
              <span className="col-plays">{a.play_count}</span>
              <span className="col-plays">{a.track_count}</span>
              <span className="col-played" title={playedTitle(a.last_played_at)}>{a.last_played_at ? formatRelativeTime(a.last_played_at) : ""}</span>
            </div>
          );
        })}
      </div>
    );
  }

  function renderTrackList(rows: TrackLikeRow[]) {
    const isRecent = activeTab === "recent";
    return (
      <div className="entity-list">
        {rows.map((t, i) => {
          const key = rowKey(activeTab, t);
          const img = trackImageUrl(t);
          const artTrack = { artist_name: t.display_artist, path: t.display_path };
          const meta = isRecent
            ? <span title={playedTitle((t as HistoryEntry).played_at)}>{formatRelativeTime((t as HistoryEntry).played_at)}</span>
            : <>#{(t as HistoryMostPlayed).rank} {"·"} {playsLabel(t.play_count)}</>;
          return (
            <TrackRow
              key={key}
              {...rowState(i, key)}
              playing={isPlayingRow(t)}
              dataAttrs={{ "data-history-index": i }}
              leading={likeFor(t)}
              thumb={img ? { kind: "image", url: img, track: artTrack } : { kind: "disc", track: artTrack }}
              title={t.display_title}
              subtitle={<>
                {artistLink(t.display_artist)}
                {t.display_album && <> {"·"} {albumLink(t)}</>}
              </>}
              meta={meta}
              onClick={(e) => handleRowClick(e, i)}
              onMouseDown={(e) => handleMouseDown(e, i)}
              onDoubleClick={() => playOne(t)}
              onContextMenu={(e) => handleContextMenu(e, i)}
              actions={{ onPlay: () => playOne(t), onEnqueue: () => enqueueOne(t), onStartRadio: radioFor(t), onDetails: () => openTrackPage(t) }}
            />
          );
        })}
      </div>
    );
  }

  function renderArtistList(rows: HistoryArtistStats[]) {
    return (
      <div className="entity-list">
        {rows.map((a, i) => {
          const key = rowKey("artists", a);
          const img = artistImageUrl(a.display_name);
          return (
            <TrackRow
              key={key}
              {...rowState(i, key)}
              dataAttrs={{ "data-history-index": i }}
              thumb={img ? { kind: "image", url: img, fallback: { kind: "artist" } } : { kind: "artist" }}
              thumbClassName="entity-list-img circular"
              title={a.display_name}
              subtitle={<>{a.track_count} track{a.track_count === 1 ? "" : "s"}</>}
              meta={<>#{a.rank} {"·"} {playsLabel(a.play_count)}</>}
              onClick={(e) => handleRowClick(e, i)}
              onDoubleClick={() => openArtist(a)}
              onContextMenu={(e) => handleContextMenu(e, i)}
              actions={{ onPlay: () => playArtistRow(a, false), onEnqueue: () => playArtistRow(a, true), onDetails: () => openArtist(a) }}
            />
          );
        })}
      </div>
    );
  }

  function renderTrackTiles(rows: TrackLikeRow[]) {
    const isRecent = activeTab === "recent";
    return (
      <div className="tiles-scroll">
        <div className="entity-grid">
          {rows.map((t, i) => {
            const key = rowKey(activeTab, t);
            const img = trackImageUrl(t);
            const second = isRecent ? formatRelativeTime((t as HistoryEntry).played_at) : playsLabel(t.play_count);
            return (
              <div key={key} data-history-index={i} className="history-tile">
                <TrackCard
                  art={img ? { kind: "image", url: img, alt: t.display_title } : { kind: "placeholder", track: { artist_name: t.display_artist, path: t.display_path } }}
                  title={t.display_title}
                  subtitle={<>{t.display_artist && <>{t.display_artist} {"·"} </>}{second}</>}
                  liked={0}
                  track={{ title: t.display_title, artist_name: t.display_artist }}
                  playing={isPlayingRow(t)}
                  selected={selected.has(key)}
                  onClick={(e) => handleRowClick(e, i)}
                  onMouseDown={(e) => handleMouseDown(e, i)}
                  onDoubleClick={() => playOne(t)}
                  onContextMenu={(e) => handleContextMenu(e, i)}
                  onPlay={() => playOne(t)}
                  onLocate={() => openTrackPage(t)}
                  onToggleLike={() => onToggleLike(historyQueueTrack(t))}
                  onToggleDislike={() => onToggleDislike(historyQueueTrack(t))}
                />
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function renderArtistTiles(rows: HistoryArtistStats[]) {
    return (
      <div className="tiles-scroll">
        <div className="entity-grid">
          {rows.map((a, i) => {
            const key = rowKey("artists", a);
            const img = artistImageUrl(a.display_name);
            return (
              <div
                key={key}
                data-history-index={i}
                className={`artist-card${selected.has(key) ? " selected" : ""}`}
                onClick={(e) => handleRowClick(e, i)}
                onContextMenu={(e) => handleContextMenu(e, i)}
              >
                <div className="album-card-art-wrapper" onClick={(e) => { e.stopPropagation(); openArtist(a); }}>
                  <div className="artist-card-art">
                    {img ? <img className="artist-card-art-img" src={img} alt={a.display_name} /> : <EntityArtFallback kind="artist" />}
                  </div>
                  <button className="album-card-menu-btn" onClick={(e) => { e.stopPropagation(); handleContextMenu(e, i); }} title="More options">&#x22EF;</button>
                  <button className="ds-card-play" onClick={(e) => { e.stopPropagation(); playArtistRow(a, false); }} title="Play">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg>
                  </button>
                </div>
                <div className="artist-card-body">
                  <div className="artist-card-name" title={a.display_name}>{a.display_name}</div>
                  <div className="history-tile-sub">{playsLabel(a.play_count)}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function renderBody() {
    if (!current.loaded) return null;
    if (current.error) {
      return (
        <div className="empty history-error">
          <p>Couldn't load your history.</p>
          <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={retry}>Try again</button>
        </div>
      );
    }
    if (current.rows.length === 0) {
      const anyHistory = recent.total > 0 || tracks.total > 0 || artists.total > 0 || range !== "all-time";
      let message = "No play history yet. Start listening to build your history.";
      if (debouncedQuery) message = `No ${activeTab === "artists" ? "artists" : "plays"} matching "${debouncedQuery}"`;
      else if (anyHistory) message = `No ${activeTab === "artists" ? "artists" : activeTab === "tracks" ? "tracks" : "plays"} in this range.`;
      return <div className="empty">{message}</div>;
    }
    if (activeTab === "artists") {
      const rows = current.rows as HistoryArtistStats[];
      return viewMode === "basic" ? renderArtistTable(rows) : viewMode === "tiles" ? renderArtistTiles(rows) : renderArtistList(rows);
    }
    const rows = current.rows as TrackLikeRow[];
    return viewMode === "basic" ? renderTrackTable(rows) : viewMode === "tiles" ? renderTrackTiles(rows) : renderTrackList(rows);
  }

  // A ghost play has no file, so its media type is unknown — which is why,
  // unlike the Library, the sort bar has no Audio/Video filter.
  const chain = sortChains[activeTab];

  return (
    <div className="search-view history-view">
      <div className="search-view-input-wrapper">
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          className="search-view-input"
          type="text"
          placeholder="Search your history..."
          aria-label="Search history"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleInputKeyDown}
          spellCheck={false}
          autoFocus
        />
        {query && (
          <button className="search-view-clear" onClick={() => onQueryChange("")} title="Clear">
            <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      <div className="ds-tabs" style={{ padding: "0 16px", gap: 4 }}>
        <div style={{ display: "flex", flex: 1 }}>
          {(["recent", "tracks", "artists"] as HistoryTab[]).map(tab => (
            <button
              key={tab}
              className={`ds-tab ${activeTab === tab ? "active" : ""}`}
              onClick={() => setTab(tab)}
              role="tab"
              aria-selected={activeTab === tab}
              aria-label={TAB_LABELS[tab]}
            >
              {TAB_LABELS[tab]}
              {data[tab].total > 0 && <span className="ds-tab-badge">{data[tab].total}</span>}
            </button>
          ))}
        </div>
        {/* In the tab bar, not the collapsible sort bar: it decides what every
            tab counts, so it must be on screen whenever the numbers are. */}
        <div className="history-range" role="group" aria-label="Range">
          {HISTORY_RANGES.map(r => (
            <button
              key={r.key}
              className={`sort-btn${range === r.key ? " active" : ""}`}
              aria-pressed={range === r.key}
              onClick={() => setRange(r.key)}
            >{r.label}</button>
          ))}
        </div>
        <button className="sort-btn sort-bar-toggle" onClick={() => update(s => ({ ...s, sortBarCollapsed: !s.sortBarCollapsed }))} title={sortBarCollapsed ? "Show sort bar" : "Hide sort bar"}>{sortBarCollapsed ? "▼" : "▲"}</button>
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
      </div>

      <div className={`sort-bar-wrapper${sortBarCollapsed ? " collapsed" : ""}`}>
        <div className="sort-bar">
          <div className="sort-bar-row">
            <span className="sort-bar-label">Sort:</span>
            <div className="sort-bar-group">
              {SORT_BUTTONS[activeTab].map(b => (
                <SortButton key={b.field} label={b.label} field={b.field} chain={chain} onClick={handleSort} />
              ))}
              {chain.length >= 2 && (
                <button className="sort-btn sort-btn-clear" onClick={() => setSortChain([])}>Clear</button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="search-view-results history-content" ref={resultsRef}>
        {renderBody()}
        <LoadMoreSentinel hasMore={current.hasMore} loading={current.loadingMore} onLoadMore={handleLoadMore} />
      </div>
    </div>
  );
}
