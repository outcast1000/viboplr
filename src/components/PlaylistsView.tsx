import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { computeSelection } from "../utils/rowSelection";
import { fetchLikeStates, applyLikeState } from "../utils/likeReconcile";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { subscribe, combineUnlisten } from "../utils/tauriEvents";
import { formatDuration } from "../utils";
import { save, open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { IMAGE_PICKER_FILTERS } from "../utils/imageFileFilters";
import { DeletePlaylistModal } from "./DeletePlaylistModal";
import { EditTrackMetadataModal, buildTrackInfoEntries, type TrackMetadataEdit } from "./EditTrackMetadataModal";
import type { PluginMenuItem, PluginContextMenuTarget } from "../types/plugin";
import type { PlaylistContext } from "../hooks/useQueue";
import type { QueueTrack } from "../types";
import { playlistTrackToQueueTrack } from "../queueEntry";
import type { ExportTrack } from "./MixtapeExportModal";
import { showNativeMenu, type MenuItemSpec } from "../nativeMenu";
import { DetailHero } from "./DetailHero";
import { TrackRow, type TrackRowThumb } from "./TrackRow";
import { ViewSearchBar } from "./ViewSearchBar";
import { buildHeroOverflowItems, type HeroOverflowItem } from "../utils/heroOverflow";
import playlistDefault from "../assets/playlist-default.png";
import { resolveImageUrl } from "../utils/resolveImageUrl";
import { IconHeartFilled, IconBan, IconRefresh, IconSparkles } from "./Icons";
import { LikeDislikeButtons } from "./LikeDislikeButtons";
import { nextTriState } from "../likeKeys";
import { isAuto, isProtectedSystem, comparePlaylists, playlistKind, playlistKindLabel, parseRecipe, autoRecipeLabel, firstArtist, featuredArtists, featuredArtistsFromMetadata, featuredArtistsLabel, parsePlaylistMetadata, type PlaylistKind } from "../utils/autoPlaylist";
import { store } from "../store";
import type { ViewMode } from "../types";
import { ViewModeToggle } from "./ViewModeToggle";
import { SortButton } from "./search/searchShared";
import { EntityRowActions } from "./search/SearchEntityResults";
import { toggleSortKey, chainDir, type SortKey } from "../sortChain";
import { TrackCard, type TrackCardArt } from "./TrackCard";
import { filterPlaylistTracks, sortPlaylistTracks, chainIsStoredOrder, type TrackMediaFilter } from "../utils/playlistTrackList";
import { buildAddToPlaylistSubmenu } from "../contextMenu/addToPlaylistMenu";
import { computeReorderedIds } from "../utils/playlistReorder";
import type { UserPlaylist } from "../hooks/useUserPlaylists";
import { SavePlaylistModal } from "./SavePlaylistModal";
import { useImageCache } from "../hooks/useImageCache";
import { useQueueVideoFrames, shelfVideoKey } from "../hooks/useShelfVideoFrames";
import { resolveTrackImage, pickEntityImagePath } from "../utils/trackImage";
import "./PlaylistsView.css";

interface Playlist {
  id: number;
  name: string;
  source: string | null;
  saved_at: number;
  image_path: string | null;
  track_count: number;
  description: string | null;
  metadata: string | null;
  system_kind: string | null;
}

interface PlaylistTrack {
  id: number;
  playlist_id: number;
  position: number;
  title: string;
  artist_name: string | null;
  album_name: string | null;
  duration_secs: number | null;
  source: string | null;
  image_path: string | null;
  // Not stored on the playlist row — reconciled from the durable entity_likes
  // store when tracks are loaded (see loadPlaylistTracks), so queued copies show
  // the correct like state. -1/0/1; undefined until reconciled.
  liked?: number;
}

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}


// Delegates to the shared conversion in queueEntry.ts (also used by the
// control API's playlists.play) so the two can't drift.
function playlistTrackToMinimalTrack(t: PlaylistTrack): QueueTrack {
  return playlistTrackToQueueTrack(t);
}

interface PlaylistsViewProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onPlayTracks: (tracks: any[], startIndex: number, context?: PlaylistContext | null) => void;
  onEnqueueTracks: (tracks: any[]) => void;
  onStartRadio?: (seed: { title: string; artistName: string | null; coverPath: string | null }) => void;
  onLocateTrack?: (title: string, artistName: string | null, albumName: string | null) => void;
  onExportAsMixtape?: (tracks: ExportTrack[], defaultTitle?: string, coverPath?: string | null, metadata?: Record<string, string> | null) => void;
  pluginMenuItems?: PluginMenuItem[];
  onPluginAction?: (pluginId: string, actionId: string, target: PluginContextMenuTarget) => void;
  onTrackDragStart?: (tracks: QueueTrack[]) => void;
  // Canonical like/dislike (useLikeActions) — metadata-keyed, so a track can be
  // unliked here even when it's no longer in the library. On the "Liked Tracks"
  // system playlist an unlike drops the row on the next entity_likes reload.
  onToggleLike?: (track: QueueTrack) => void;
  onToggleDislike?: (track: QueueTrack) => void;
  /** The user's own (mutable) playlists, for the detail view's "Add to Playlist ▸" submenu. */
  userPlaylists?: UserPlaylist[];
  /** Append tracks to another user playlist (App owns the invoke + toast). */
  onAddTracksToPlaylist?: (playlistId: number, playlistName: string, tracks: QueueTrack[]) => void;
  /** Create a new playlist from tracks (App opens the save modal). */
  onCreatePlaylistFromTracks?: (tracks: QueueTrack[]) => void;
  /** Open the searchable playlist picker (the submenu caps its list). */
  onBrowsePlaylists?: (tracks: QueueTrack[], excludeId?: number) => void;
  /** Lightweight feedback (useToasts.notify). */
  onNotify?: (message: string) => void;
}

function isLocalPath(source: string | null): boolean {
  return !!source && source.startsWith("file://");
}

type PlaylistKindFilter = "all" | PlaylistKind;

// Persisted like SearchView's `searchSettings`: view mode, sort chain, kind
// filter and the sort bar's collapsed state survive view switches + restarts.
interface PlaylistsViewSettings {
  viewMode: ViewMode;
  sortChain: SortKey[];
  kindFilter: PlaylistKindFilter;
  sortBarCollapsed: boolean;
}

// Same idea for the playlist detail's track list — view mode, media filter and
// the sort bar's collapsed state are shared by all playlists. The SORT CHAIN is
// not: it persists per playlist (see `playlistTrackSortChains` below), because
// a global chain silently disabled drag-to-reorder on every playlist after one
// sort click anywhere. The search query is not persisted — it resets per
// playlist.
interface PlaylistTracksViewSettings {
  viewMode: ViewMode;
  /** Legacy: the old global chain. No longer applied or written — each playlist
   *  now carries its own chain — but kept in the type so old stores parse. */
  sortChain?: SortKey[];
  mediaFilter: TrackMediaFilter;
  sortBarCollapsed: boolean;
}

// Per-playlist sort chains, keyed by playlist id. Absent key = natural
// (stored) order, which is what makes a fresh user playlist reorderable.
type PlaylistTrackSortChains = Record<string, SortKey[]>;


export function PlaylistsView({ searchQuery, onSearchChange, onPlayTracks, onEnqueueTracks, onStartRadio, onLocateTrack, onExportAsMixtape, pluginMenuItems, onPluginAction, onTrackDragStart, onToggleLike, onToggleDislike, userPlaylists, onAddTracksToPlaylist, onCreatePlaylistFromTracks, onBrowsePlaylists, onNotify }: PlaylistsViewProps) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<PlaylistTrack[]>([]);
  const [deleteConfirm, setDeleteConfirm] = useState<Playlist | null>(null);
  const [editTrack, setEditTrack] = useState<PlaylistTrack | null>(null);
  // "Edit details…" (rename / description / cover) for the open user playlist.
  const [editDetails, setEditDetails] = useState(false);
  // Drag-to-reorder insert indicator: rows at or after this display index shift
  // to show the drop line. Null while no reorder drag is live.
  const [reorderInsertIndex, setReorderInsertIndex] = useState<number | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [refreshingAuto, setRefreshingAuto] = useState(false);
  // Detail-view multi-select (by playlist-track id) + drag-to-queue handshake.
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<number>>(new Set());
  const lastClickedTrackRef = useRef<number | null>(null);
  const didDragRef = useRef(false);
  const artistImages = useImageCache("artist");
  const albumImages = useImageCache("album");

  // List-view presentation state (see PlaylistsViewSettings above).
  const [viewMode, setViewMode] = useState<ViewMode>("tiles");
  const [sortChain, setSortChain] = useState<SortKey[]>([]);
  const [kindFilter, setKindFilter] = useState<PlaylistKindFilter>("all");
  const [sortBarCollapsed, setSortBarCollapsed] = useState(true);
  const settingsRestoredRef = useRef(false);

  // Detail-view (track list) presentation state — see PlaylistTracksViewSettings.
  const [trackQuery, setTrackQuery] = useState("");
  const [trackViewMode, setTrackViewMode] = useState<ViewMode>("list");
  const [trackSortChain, setTrackSortChain] = useState<SortKey[]>([]);
  const [trackMediaFilter, setTrackMediaFilter] = useState<TrackMediaFilter>("all");
  const [trackSortBarCollapsed, setTrackSortBarCollapsed] = useState(true);
  // Seed for the Shuffle sort; bumped per Shuffle click so each click re-rolls
  // while re-renders keep the same order (see sortPlaylistTracks).
  const [shuffleKey, setShuffleKey] = useState(1);
  // Per-playlist sort chains (see PlaylistTrackSortChains). A ref: read when a
  // playlist opens and written when its chain changes — never during render.
  const trackSortChainsRef = useRef<PlaylistTrackSortChains>({});

  useEffect(() => {
    Promise.all([
      store.get<PlaylistsViewSettings>("playlistsViewSettings"),
      store.get<PlaylistTracksViewSettings>("playlistTracksViewSettings"),
      store.get<PlaylistTrackSortChains>("playlistTrackSortChains"),
    ])
      .then(([saved, savedTracks, savedChains]) => {
        if (saved) {
          setViewMode(saved.viewMode ?? "tiles");
          setSortChain(saved.sortChain ?? []);
          setKindFilter(saved.kindFilter ?? "all");
          setSortBarCollapsed(saved.sortBarCollapsed ?? true);
        }
        if (savedTracks) {
          setTrackViewMode(savedTracks.viewMode ?? "list");
          // Deliberately NOT savedTracks.sortChain: the legacy global chain
          // gated reordering on every playlist at once. Chains are per-playlist
          // now; the legacy value is dropped rather than migrated (there is no
          // "the playlist it belonged to").
          setTrackMediaFilter(savedTracks.mediaFilter ?? "all");
          setTrackSortBarCollapsed(savedTracks.sortBarCollapsed ?? true);
        }
        if (savedChains) trackSortChainsRef.current = savedChains;
      })
      .catch((e) => console.error("Failed to restore playlists view settings:", e))
      .finally(() => { settingsRestoredRef.current = true; });
  }, []);

  useEffect(() => {
    if (!settingsRestoredRef.current) return;
    store.set("playlistsViewSettings", { viewMode, sortChain, kindFilter, sortBarCollapsed })
      .catch((e) => console.error("Failed to persist playlists view settings:", e));
  }, [viewMode, sortChain, kindFilter, sortBarCollapsed]);

  useEffect(() => {
    if (!settingsRestoredRef.current) return;
    store.set("playlistTracksViewSettings", { viewMode: trackViewMode, mediaFilter: trackMediaFilter, sortBarCollapsed: trackSortBarCollapsed })
      .catch((e) => console.error("Failed to persist playlist tracks view settings:", e));
  }, [trackViewMode, trackMediaFilter, trackSortBarCollapsed]);

  // Persist the open playlist's own sort chain. An empty chain deletes the
  // entry (absent = natural order), and ids of since-deleted playlists are
  // pruned so the record doesn't grow forever.
  useEffect(() => {
    if (!settingsRestoredRef.current || !selectedPlaylist) return;
    const chains = { ...trackSortChainsRef.current };
    if (trackSortChain.length > 0) chains[String(selectedPlaylist.id)] = trackSortChain;
    else delete chains[String(selectedPlaylist.id)];
    if (playlists.length > 0) {
      const live = new Set(playlists.map(p => String(p.id)));
      for (const id of Object.keys(chains)) {
        if (!live.has(id)) delete chains[id];
      }
    }
    trackSortChainsRef.current = chains;
    store.set("playlistTrackSortChains", chains)
      .catch((e) => console.error("Failed to persist playlist sort chains:", e));
  }, [trackSortChain, selectedPlaylist, playlists]);

  const handleSortClick = useCallback((field: string, e?: React.MouseEvent) => {
    setSortChain(prev => toggleSortKey(prev, field, e?.shiftKey ?? false));
  }, []);

  const sortIndicator = useCallback((field: string) => {
    const dir = chainDir(sortChain, field);
    return dir ? (dir === "asc" ? " ▲" : " ▼") : "";
  }, [sortChain]);

  const handleTrackSortClick = useCallback((field: string, e?: React.MouseEvent) => {
    if (field === "random") setShuffleKey(k => k + 1);
    setTrackSortChain(prev => toggleSortKey(prev, field, e?.shiftKey ?? false));
  }, []);

  const trackSortIndicator = useCallback((field: string) => {
    const dir = chainDir(trackSortChain, field);
    return dir ? (dir === "asc" ? " ▲" : " ▼") : "";
  }, [trackSortChain]);

  // Build the queue's PlaylistContext. Auto-playlists ("Made for you") store no
  // image_path, so fall back to the mix's first-artist image — the same raw path
  // autoCoverSrc resolves for the card — otherwise the queue banner cover is blank.
  const playlistContext = useCallback((pl: Playlist): PlaylistContext => {
    const metadata = parsePlaylistMetadata(pl.metadata);
    let imagePath = pl.image_path;
    if (!imagePath) {
      const artist = firstArtist(pl.metadata);
      imagePath = artist ? artistImages.getImage(artist) : null;
    }
    return {
      name: pl.name,
      imagePath,
      source: pl.source ?? "playlist",
      description: pl.description,
      metadata,
      remote: false,
    };
  }, [artistImages]);

  const loadPlaylists = useCallback(async () => {
    const rows = await invoke<Playlist[]>("get_playlists");
    setPlaylists(rows);
  }, []);

  // Fetch a playlist's tracks and reconcile each track's like state from the
  // durable entity_likes store (playlist rows store none). Without this, tracks
  // queued from a playlist — including the "Liked"/"Disliked" system playlists —
  // would always render as neutral in the queue/now-playing like control.
  const loadPlaylistTracks = useCallback(async (playlistId: number): Promise<PlaylistTrack[]> => {
    const rows = await invoke<PlaylistTrack[]>("get_playlist_tracks", { playlistId });
    if (rows.length === 0) return rows;
    try {
      const byId = await fetchLikeStates(rows);
      return rows.map(t => applyLikeState(t, byId));
    } catch (e) {
      console.error("Failed to reconcile playlist like states:", e);
      return rows;
    }
  }, []);

  // Force-regenerate the algorithmic mixes, then reload. The on-mount refresh
  // (24h-gated) lives in App.tsx; this is the user-initiated override.
  const handleRefreshAuto = useCallback(async () => {
    setRefreshingAuto(true);
    try {
      await invoke("ensure_auto_playlists", { force: true });
      // Read the rows here rather than via loadPlaylists so we can tell the
      // user when the run produced nothing: the backend persists no empty
      // mixes, so a generate that can't find enough library material is a
      // silent no-op otherwise.
      const rows = await invoke<Playlist[]>("get_playlists");
      setPlaylists(rows);
      if (!rows.some(isAuto)) {
        onNotify?.("No mixes yet — they need a scanned collection, and improve once you've played and liked some tracks.");
      }
    } catch (e) {
      console.error("Failed to refresh auto playlists:", e);
      onNotify?.("Couldn't generate your mixes.");
    } finally {
      setRefreshingAuto(false);
    }
  }, [onNotify]);

  useEffect(() => {
    loadPlaylists();
  }, [loadPlaylists]);

  useEffect(() => {
    const stopLikes = subscribe("entity-likes-changed", () => {
      loadPlaylists().catch(console.error);
      // Reconcile the open playlist's rows from the durable entity_likes store so
      // the per-row like indicator stays correct. For the projected "Liked/Disliked
      // Tracks" system playlists this also re-runs the projection, so an unliked
      // track drops out of the list. (Reading uses `prev` to avoid the stale-closure
      // capture of selectedPlaylist inside this long-lived subscription.)
      setSelectedPlaylist(prev => {
        if (prev) {
          loadPlaylistTracks(prev.id)
            .then(setTracks)
            .catch(console.error);
        }
        return prev;
      });
    });
    // Reload when a playlist is saved/deleted anywhere (queue "Save as Playlist",
    // plugin saves, etc.) so a mounted Playlists view stays current.
    const stopPlaylists = subscribe("playlists-changed", () => {
      loadPlaylists().catch(console.error);
    });
    return combineUnlisten(stopLikes, stopPlaylists);
  }, [loadPlaylists, loadPlaylistTracks]);

  const openPlaylist = useCallback(async (pl: Playlist) => {
    setSelectedPlaylist(pl);
    setSelectedTrackIds(new Set());
    setTrackQuery("");
    // Each playlist carries its own sort; absent = natural (stored) order.
    setTrackSortChain(trackSortChainsRef.current[String(pl.id)] ?? []);
    lastClickedTrackRef.current = null;
    setTracks(await loadPlaylistTracks(pl.id));
  }, [loadPlaylistTracks]);

  const goBack = useCallback(() => {
    setSelectedPlaylist(null);
    setTracks([]);
    setSelectedTrackIds(new Set());
    setTrackQuery("");
    lastClickedTrackRef.current = null;
  }, []);

  // What the detail view actually renders: the playlist's tracks through the
  // instant client-side search + media filter, then the user's sort chain.
  // Every surface below — rows, hero Play/Enqueue, selection, drag — operates
  // on this list, so what you see is always what plays.
  const displayTracks = useMemo(
    () => sortPlaylistTracks(filterPlaylistTracks(tracks, trackQuery, trackMediaFilter), trackSortChain, shuffleKey),
    [tracks, trackQuery, trackMediaFilter, trackSortChain, shuffleKey],
  );

  // Editing (remove / reorder / rename / cover) is user playlists only: the
  // liked/disliked projections have no real rows and auto mixes are regenerated
  // snapshots — the backend rejects mutations on both, so don't offer them.
  const editable = !!selectedPlaylist && !selectedPlaylist.system_kind;
  // Reordering is only meaningful when the rows are shown in their stored
  // (position) order with nothing filtered out — under a sort or filter the
  // on-screen neighbors aren't the position neighbors, so a drop is ambiguous.
  // "# ascending" counts as stored order (chainIsStoredOrder).
  const naturalOrder = chainIsStoredOrder(trackSortChain) && !trackQuery.trim() && trackMediaFilter === "all";

  // The rows a row-level action applies to: the whole multi-selection when the
  // pressed row is part of one, else just that row (same rule as the drag).
  const effectiveSelection = useCallback((t: PlaylistTrack): PlaylistTrack[] =>
    (selectedTrackIds.has(t.id) && selectedTrackIds.size > 1)
      ? displayTracks.filter(x => selectedTrackIds.has(x.id))
      : [t],
  [selectedTrackIds, displayTracks]);

  // Remove rows from the open user playlist. Optimistic (the rows vanish at
  // once), reverts from DB on failure — the handleEditTrackSave precedent.
  const handleRemoveTracks = useCallback(async (sel: PlaylistTrack[]) => {
    if (!selectedPlaylist || sel.length === 0) return;
    const playlistId = selectedPlaylist.id;
    const ids = new Set(sel.map(t => t.id));
    // Renumber the survivors like the backend does — positions are visible
    // (the "#" column), so a gap would show until the next reload.
    setTracks(prev => prev.filter(t => !ids.has(t.id)).map((t, i) => ({ ...t, position: i })));
    setSelectedTrackIds(new Set());
    try {
      await invoke("remove_playlist_tracks", { playlistId, trackIds: [...ids] });
    } catch (e) {
      console.error("Failed to remove playlist tracks:", e);
      setTracks(await loadPlaylistTracks(playlistId));
    }
  }, [selectedPlaylist, loadPlaylistTracks]);

  // Save the "Edit details…" modal: rename/description, then the cover only
  // when it changed. Optimistic on the open playlist; reverts via reload.
  const handleEditDetailsSave = useCallback(async (name: string, imagePath: string | null, description: string | null) => {
    if (!selectedPlaylist) return;
    const prev = selectedPlaylist;
    setEditDetails(false);
    const patch = { ...prev, name, description };
    setSelectedPlaylist(patch);
    setPlaylists(list => list.map(p => (p.id === prev.id ? { ...p, name, description } : p)));
    try {
      await invoke("update_playlist_meta", { playlistId: prev.id, name, description });
      if (imagePath !== prev.image_path) {
        const stored = await invoke<string | null>("set_playlist_cover", { playlistId: prev.id, imagePath });
        setSelectedPlaylist(cur => (cur && cur.id === prev.id ? { ...cur, image_path: stored } : cur));
      }
    } catch (e) {
      console.error("Failed to update playlist details:", e);
      // Re-read the truth rather than restoring `prev` — the rename may have
      // landed even though the cover write failed.
      try {
        const rows = await invoke<Playlist[]>("get_playlists");
        setPlaylists(rows);
        const fresh = rows.find(p => p.id === prev.id);
        if (fresh) setSelectedPlaylist(fresh);
      } catch (e2) {
        console.error("Failed to reload playlists after edit failure:", e2);
      }
    }
  }, [selectedPlaylist]);

  // Cover art, reachable from the hero ⋯ and the grid right-click menu without
  // going through the Edit-details modal — parity with the artist/album/tag
  // detail pages, which offer Set/Paste/Remove image straight from the hero.
  //
  // Takes a playlist id rather than reading `selectedPlaylist`, because the grid
  // menu acts on a row that isn't open. `imagePath` is a temp copy already
  // inside playlist_images/; `set_playlist_cover` re-copies it under a
  // timestamped name it owns and deletes the temp, so nothing else may store
  // the picked path as-is.
  const applyCover = useCallback(async (playlistId: number, imagePath: string | null) => {
    try {
      const stored = await invoke<string | null>("set_playlist_cover", { playlistId, imagePath });
      setPlaylists(list => list.map(p => (p.id === playlistId ? { ...p, image_path: stored } : p)));
      setSelectedPlaylist(cur => (cur && cur.id === playlistId ? { ...cur, image_path: stored } : cur));
    } catch (e) {
      console.error("Failed to set playlist cover:", e);
    }
  }, []);

  const handleSetCoverFromFile = useCallback(async (playlistId: number) => {
    const selected = await openFileDialog({
      multiple: false,
      filters: IMAGE_PICKER_FILTERS,
    });
    if (!selected || typeof selected !== "string") return;
    try {
      const copied = await invoke<string>("copy_to_playlist_images", { sourcePath: selected });
      await applyCover(playlistId, copied);
    } catch (e) {
      console.error("Failed to copy playlist image:", e);
    }
  }, [applyCover]);

  const handlePasteCover = useCallback(async (playlistId: number) => {
    try {
      const path = await invoke<string>("paste_clipboard_to_playlist_images");
      await applyCover(playlistId, path);
    } catch (e) {
      console.error("Failed to paste playlist image:", e);
    }
  }, [applyCover]);

  // Left-click selection over the detail rows (Cmd/Ctrl = toggle, Shift = range).
  // Suppressed right after a drag and when the click lands on a hover-tray button.
  const handleRowClick = useCallback((e: React.MouseEvent, index: number) => {
    if (didDragRef.current) return;
    if ((e.target as HTMLElement).closest(".row-hover-action, .ds-card-play, .album-card-menu-btn")) return;
    const ids = displayTracks.map(t => t.id);
    setSelectedTrackIds(prev => computeSelection(prev, index, ids, lastClickedTrackRef.current, e.metaKey || e.ctrlKey, e.shiftKey));
    lastClickedTrackRef.current = index;
  }, [displayTracks]);

  // Apply a reorder drop: permute `tracks` optimistically (positions
  // reassigned client-side so the Edit-info modal's position stays right),
  // then persist. Reverts from DB on failure.
  const applyReorder = useCallback(async (movedIds: number[], insertAt: number) => {
    if (!selectedPlaylist) return;
    const playlistId = selectedPlaylist.id;
    const ids = tracks.map(t => t.id);
    const orderedIds = computeReorderedIds(ids, movedIds, insertAt);
    if (orderedIds === ids) return; // no-op move (same reference back)
    const byId = new Map(tracks.map(t => [t.id, t]));
    setTracks(orderedIds.map((id, i) => ({ ...byId.get(id)!, position: i })));
    try {
      await invoke("reorder_playlist_tracks", { playlistId, orderedIds });
    } catch (e) {
      console.error("Failed to reorder playlist tracks:", e);
      setTracks(await loadPlaylistTracks(playlistId));
    }
  }, [selectedPlaylist, tracks, loadPlaylistTracks]);

  // Row drag. Two gestures share the mousedown, raw mouse listeners per the
  // WKWebView drag rule:
  // - On an editable user playlist in natural order (list/table modes), the drag
  //   REORDERS within the playlist — rows carry data-pl-index, the drop line
  //   comes from row midpoints — and hands off to the shared drag-to-queue
  //   handshake if the pointer enters the queue panel mid-gesture.
  // - Everywhere else it's the plain drag-to-queue it always was.
  const handleRowMouseDown = useCallback((e: React.MouseEvent, index: number) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".row-hover-action, .ds-card-play, .album-card-menu-btn")) return;
    const canReorder = editable && naturalOrder && trackViewMode !== "tiles";
    // Reorder intent that's currently gated (a search, sort or filter is
    // active): keep the local drag so a drop inside the list can SAY why
    // nothing moved, instead of silently doing nothing.
    const reorderGated = editable && !naturalOrder && trackViewMode !== "tiles";
    if (!canReorder && !onTrackDragStart) return;
    const startX = e.clientX, startY = e.clientY;
    didDragRef.current = false;
    const clicked = displayTracks[index];
    const source = (selectedTrackIds.has(clicked.id) && selectedTrackIds.size > 1)
      ? displayTracks.filter(t => selectedTrackIds.has(t.id))
      : [clicked];

    let ghost: HTMLDivElement | null = null;
    let insertAt: number | null = null;
    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (ghost) { ghost.remove(); ghost = null; }
      setReorderInsertIndex(null);
    };
    const onMove = (ev: MouseEvent) => {
      if (!didDragRef.current) {
        if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 5) return;
        didDragRef.current = true;
        if (!canReorder && !reorderGated) {
          // Plain drag-to-queue: hand the whole gesture to the shared handshake.
          cleanup();
          onTrackDragStart?.(source.map(playlistTrackToMinimalTrack));
          return;
        }
        ghost = document.createElement("div");
        ghost.className = "queue-drag-ghost";
        ghost.textContent = `${source.length} track${source.length > 1 ? "s" : ""}`;
        document.body.appendChild(ghost);
      }
      if (ghost) {
        ghost.style.left = `${ev.clientX + 12}px`;
        ghost.style.top = `${ev.clientY - 10}px`;
      }
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      if (onTrackDragStart && under?.closest(".queue-panel")) {
        // Crossed into the queue panel: this is a drag-to-queue after all.
        // The shared handshake installs its own listeners (the button is still
        // down) and draws its own ghost, so drop ours entirely.
        cleanup();
        onTrackDragStart(source.map(playlistTrackToMinimalTrack));
        return;
      }
      const rowEl = under?.closest("[data-pl-index]") as HTMLElement | null;
      if (rowEl) {
        const overIndex = parseInt(rowEl.getAttribute("data-pl-index")!, 10);
        const rect = rowEl.getBoundingClientRect();
        insertAt = ev.clientY < rect.top + rect.height / 2 ? overIndex : overIndex + 1;
      } else if (under?.closest(".playlists-track-list")) {
        insertAt = displayTracks.length; // below the last row → end
      } else {
        insertAt = null;
      }
      // No drop indicator while gated — the drop can't land anywhere.
      setReorderInsertIndex(canReorder ? insertAt : null);
    };
    const onUp = () => {
      const dropAt = insertAt;
      const dragged = didDragRef.current;
      cleanup();
      if (!dragged || dropAt === null) return;
      if (canReorder) {
        applyReorder(source.map(t => t.id), dropAt).catch(console.error);
      } else if (reorderGated) {
        onNotify?.("To reorder this playlist, clear the search, sort and filters first.");
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [displayTracks, selectedTrackIds, onTrackDragStart, editable, naturalOrder, trackViewMode, applyReorder, onNotify]);

  // Like/dislike a detail row through the canonical metadata-keyed path
  // (useLikeActions, wired from App). The row is reflected optimistically for
  // instant feedback; the entity-likes-changed reload then reconciles the
  // authoritative state — and on "Liked/Disliked Tracks" re-projects the list so
  // a no-longer-qualifying track drops out.
  const rateTrack = useCallback((t: PlaylistTrack, action: "like" | "dislike") => {
    const qt = playlistTrackToMinimalTrack(t);
    setTracks(prev => prev.map(x => (x.id === t.id ? { ...x, liked: nextTriState(x.liked ?? 0, action) } : x)));
    if (action === "like") onToggleLike?.(qt);
    else onToggleDislike?.(qt);
  }, [onToggleLike, onToggleDislike]);

  // Native context menu for one detail-view track — shared by the list, table
  // and tile modes so the three surfaces can't drift.
  const showTrackMenu = useCallback((e: React.MouseEvent, t: PlaylistTrack) => {
    e.preventDefault();
    const sel = effectiveSelection(t);
    const selTracks = sel.map(playlistTrackToMinimalTrack);
    const specs: MenuItemSpec[] = sel.length > 1 ? [
      { kind: "item", text: `Play ${sel.length} tracks`, action: () => onPlayTracks(selTracks, 0, selectedPlaylist ? playlistContext(selectedPlaylist) : null) },
      { kind: "item", text: `Enqueue ${sel.length} tracks`, action: () => onEnqueueTracks(selTracks) },
    ] : [
      { kind: "item", text: "Play", action: () => onPlayTracks(selTracks, 0, selectedPlaylist ? playlistContext(selectedPlaylist) : null) },
      { kind: "item", text: "Enqueue", action: () => onEnqueueTracks(selTracks) },
    ];
    // Add to Playlist — the same submenu the library/queue menus carry
    // (universal track actions), excluding the playlist being viewed.
    if (userPlaylists && onAddTracksToPlaylist && onCreatePlaylistFromTracks) {
      specs.push(buildAddToPlaylistSubmenu(userPlaylists, {
        onPick: (id, name) => onAddTracksToPlaylist(id, name, selTracks),
        onNew: () => onCreatePlaylistFromTracks(selTracks),
        onBrowse: onBrowsePlaylists ? () => onBrowsePlaylists(selTracks, selectedPlaylist?.id) : undefined,
        excludeId: selectedPlaylist?.id,
      }));
    }
    // Edit info — only on regular (user) playlists; auto/system playlist rows
    // are regenerated, so an override wouldn't stick.
    if (selectedPlaylist && !selectedPlaylist.system_kind) {
      specs.push({ kind: "separator" });
      if (sel.length === 1) {
        specs.push({ kind: "item", text: "Edit info…", action: () => setEditTrack(t) });
      }
      specs.push({
        kind: "item",
        text: sel.length > 1 ? `Remove ${sel.length} tracks from playlist` : "Remove from playlist",
        action: () => { handleRemoveTracks(sel).catch(console.error); },
      });
    }
    if (isLocalPath(t.source)) {
      specs.push({ kind: "separator" });
      specs.push({ kind: "item", text: "Open Containing Folder", action: async () => {
        try { await invoke("show_in_folder_path", { filePath: t.source! }); }
        catch (err) { console.error("Failed to open containing folder:", err); setFolderError(String(err)); }
      }});
    }
    if (pluginMenuItems && pluginMenuItems.length > 0) {
      const matching = pluginMenuItems.filter(item => item.targets.includes("track"));
      if (matching.length > 0) {
        specs.push({ kind: "separator" });
        matching.forEach(item => {
          specs.push({ kind: "item", text: item.label, action: () => onPluginAction?.(item.pluginId, item.id, { kind: "track", title: t.title, artistName: t.artist_name ?? undefined, albumTitle: t.album_name ?? undefined }) });
        });
      }
    }
    showNativeMenu(e.clientX, e.clientY, specs);
  }, [selectedPlaylist, playlistContext, onPlayTracks, onEnqueueTracks, pluginMenuItems, onPluginAction, effectiveSelection, userPlaylists, onAddTracksToPlaylist, onCreatePlaylistFromTracks, onBrowsePlaylists, handleRemoveTracks]);

  // Override a playlist entry's display metadata (title/artist/album). Persists
  // to the playlist_tracks row only — never rewrites the underlying source or
  // library files. Optimistic UI, reverts from DB on failure.
  const handleEditTrackSave = useCallback(async (fields: TrackMetadataEdit) => {
    if (!editTrack) return;
    const target = editTrack;
    setEditTrack(null);
    const artist_name = fields.artist || null;
    const album_name = fields.album || null;
    setTracks(prev => prev.map(x => (x.id === target.id ? { ...x, title: fields.title, artist_name, album_name } : x)));
    try {
      await invoke("update_playlist_track_metadata", {
        trackId: target.id,
        title: fields.title,
        artistName: artist_name,
        albumName: album_name,
      });
    } catch (e) {
      console.error("Failed to update playlist track metadata:", e);
      setTracks(await loadPlaylistTracks(target.playlist_id));
    }
  }, [editTrack, loadPlaylistTracks]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteConfirm) return;
    await invoke("delete_playlist_record", { playlistId: deleteConfirm.id });
    setDeleteConfirm(null);
    setSelectedPlaylist(null);
    setTracks([]);
    loadPlaylists();
  }, [deleteConfirm, loadPlaylists]);

  const handleExport = useCallback(async (pl: Playlist) => {
    const path = await save({
      defaultPath: `${pl.name}.m3u`,
      filters: [{ name: "Playlist", extensions: ["m3u"] }],
    });
    if (path) {
      await invoke("export_playlist_m3u", { playlistId: pl.id, path });
    }
  }, []);

  const playPlaylist = useCallback(async (pl: Playlist) => {
    const rows = await loadPlaylistTracks(pl.id);
    if (rows.length > 0) {
      onPlayTracks(rows.map(playlistTrackToMinimalTrack), 0, playlistContext(pl));
    }
  }, [onPlayTracks, playlistContext, loadPlaylistTracks]);

  const handlePlayPlaylist = useCallback((e: React.MouseEvent, pl: Playlist) => {
    e.stopPropagation();
    playPlaylist(pl).catch((err) => console.error("Failed to play playlist:", err));
  }, [playPlaylist]);

  const handleEnqueuePlaylist = useCallback(async (pl: Playlist) => {
    const rows = await loadPlaylistTracks(pl.id);
    if (rows.length > 0) {
      onEnqueueTracks(rows.map(playlistTrackToMinimalTrack));
    }
  }, [onEnqueueTracks, loadPlaylistTracks]);

  const showPlaylistMenu = useCallback(async (x: number, y: number, pl: Playlist) => {
    const specs: MenuItemSpec[] = [
      { kind: "item", text: "Play", action: () => playPlaylist(pl).catch((err) => console.error("Failed to play playlist:", err)) },
      { kind: "item", text: "Enqueue", action: () => handleEnqueuePlaylist(pl) },
      { kind: "item", text: "View / Edit", action: () => openPlaylist(pl) },
    ];
    // Cover art without opening the playlist first. Same gate as `editable` —
    // system projections and auto mixes have no user-owned cover to set.
    if (!pl.system_kind) {
      specs.push(
        { kind: "separator" },
        { kind: "item", text: "Set image…", action: () => handleSetCoverFromFile(pl.id) },
        { kind: "item", text: "Paste image", action: () => handlePasteCover(pl.id) },
      );
      if (pl.image_path) {
        specs.push({ kind: "item", text: "Remove image", action: () => { void applyCover(pl.id, null); } });
      }
    }
    specs.push(
      { kind: "separator" },
      { kind: "item", text: "Export as M3U", action: () => handleExport(pl) },
    );
    if (onExportAsMixtape) {
      specs.push({ kind: "item", text: "Export as Mixtape", action: async () => {
        try {
          const rows = await invoke<PlaylistTrack[]>("get_playlist_tracks", { playlistId: pl.id });
          if (rows.length === 0) return;
          const meta = parsePlaylistMetadata(pl.metadata);
          onExportAsMixtape(rows.map(t => ({
            title: t.title,
            artistName: t.artist_name || undefined,
            albumTitle: t.album_name || undefined,
            durationSecs: t.duration_secs || undefined,
            path: t.source || undefined,
            imageUrl: t.image_path || undefined,
          })), pl.name, pl.image_path, meta);
        } catch (e) {
          console.error("Failed to prepare mixtape export:", e);
        }
      }});
    }
    specs.push({ kind: "separator" });
    if (!isProtectedSystem(pl)) {
      specs.push({ kind: "item", text: "Delete", action: () => setDeleteConfirm(pl) });
    }
    if (pluginMenuItems && pluginMenuItems.length > 0) {
      const matching = pluginMenuItems.filter(item => item.targets.includes("playlist"));
      if (matching.length > 0) {
        specs.push({ kind: "separator" });
        matching.forEach(item => {
          specs.push({ kind: "item", text: item.label, action: () => onPluginAction?.(item.pluginId, item.id, { kind: "playlist", playlistId: pl.id, playlistName: pl.name }) });
        });
      }
    }
    await showNativeMenu(x, y, specs);
  }, [playPlaylist, handleEnqueuePlaylist, openPlaylist, handleExport, onExportAsMixtape, pluginMenuItems, onPluginAction, handleSetCoverFromFile, handlePasteCover, applyCover]);

  const handleContextMenu = useCallback((e: React.MouseEvent, pl: Playlist) => {
    e.preventDefault();
    e.stopPropagation();
    showPlaylistMenu(e.clientX, e.clientY, pl);
  }, [showPlaylistMenu]);

  const handleMoreClick = useCallback((e: React.MouseEvent, pl: Playlist) => {
    e.stopPropagation();
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    showPlaylistMenu(rect.left, rect.bottom + 4, pl);
  }, [showPlaylistMenu]);

  const imageUrl = useCallback(
    (imagePath: string | null) => {
      if (!imagePath) return undefined;
      return convertFileSrc(imagePath);
    },
    [],
  );

  // Auto-playlist covers come from the mix's first artist (recorded in metadata),
  // resolved through the canonical artist-image chain (cached → fetch → ready event).
  const autoCoverSrc = useCallback((pl: Playlist): string => {
    if (pl.image_path) return convertFileSrc(pl.image_path);
    const artist = firstArtist(pl.metadata);
    const resolved = artist ? artistImages.getImage(artist) : null;
    // resolveImageUrl (not convertFileSrc) so the #v=N cache-buster on a
    // re-fetched artist image becomes a ?v=N query and the cover reloads.
    return resolveImageUrl(resolved) ?? playlistDefault;
  }, [artistImages]);

  // Per-track artwork via the shared render-time chain (resolveTrackImage):
  // explicit image → video first-frame → album image → artist image. Album/artist
  // go through useImageCache (fetches on a disk miss and refreshes on the
  // *-image-ready events, so a row upgrades from the artist fallback to the album
  // cover once retrieved). Video frames come from the queue's on-demand extractor
  // via useQueueVideoFrames (keyed by artist::title), so a video row shows its
  // captured first frame instead of the generic disc — matching the queue panel,
  // which previously had this branch when the playlist detail didn't. Returns a
  // ready-to-render url (the video frame is already a converted asset URL and is
  // used verbatim; every other candidate goes through resolveImageUrl inside).
  const videoFrameProxy = useMemo(() => tracks.map(playlistTrackToMinimalTrack), [tracks]);
  const videoFrames = useQueueVideoFrames(videoFrameProxy);

  const resolvedTrackImage = useCallback((t: PlaylistTrack): string | null =>
    resolveTrackImage(
      { title: t.title, artist_name: t.artist_name, album_title: t.album_name, image_url: t.image_path ?? undefined },
      {
        albumImageFor: albumImages.getImage,
        artistImageFor: artistImages.getImage,
        videoFrame: videoFrames[shelfVideoKey(t.source)] ?? null,
      },
    ),
  [videoFrames, albumImages, artistImages]);

  // Per-row thumbnail. Falls back to the shared disc placeholder (the same
  // default every other track surface uses — Library list, queue, history) when
  // no art resolves, rather than the playlist cover image.
  const trackThumb = useCallback((t: PlaylistTrack): TrackRowThumb => {
    const url = resolvedTrackImage(t);
    return url ? { kind: "image", url } : { kind: "disc" };
  }, [resolvedTrackImage]);

  // Raw (unconverted) entity-image path for the radio seed's coverPath: startRadio
  // stamps it as a PlaylistContext imagePath and converts it downstream, so it
  // must stay raw — and must not be a video frame (already converted, and not a
  // meaningful station cover). Album image → artist image, no video branch.
  const rawTrackImagePath = useCallback((t: PlaylistTrack): string | null =>
    t.image_path ?? pickEntityImagePath(
      { title: t.title, artist_name: t.artist_name, album_title: t.album_name },
      { albumImageFor: albumImages.getImage, artistImageFor: artistImages.getImage },
    ),
  [albumImages, artistImages]);

  // Hero background: the playlist cover if set, else a collage of up to 4 distinct
  // resolved track images (same idea as the artist hero's album collage).
  const heroBgImages = useMemo(() => {
    if (selectedPlaylist?.image_path) {
      const u = imageUrl(selectedPlaylist.image_path);
      return u ? [u] : [];
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const t of tracks) {
      const u = resolvedTrackImage(t);
      if (!u || seen.has(u)) continue;
      seen.add(u);
      out.push(u);
      if (out.length === 4) break;
    }
    return out;
  }, [selectedPlaylist, tracks, resolvedTrackImage, imageUrl]);

  // Track-content matches come from the backend (covers materialized rows and the
  // liked/disliked entity_likes projection); name/description match client-side.
  const [trackMatchIds, setTrackMatchIds] = useState<Set<number>>(new Set());
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) { setTrackMatchIds(new Set()); return; }
    let cancelled = false;
    invoke<number[]>("search_playlist_track_ids", { query: q })
      .then((ids) => { if (!cancelled) setTrackMatchIds(new Set(ids)); })
      .catch((e) => {
        console.error("Failed to search playlist tracks:", e);
        if (!cancelled) setTrackMatchIds(new Set());
      });
    return () => { cancelled = true; };
  }, [searchQuery]);

  // Filter by search query — playlist name + description client-side (instant)
  // plus track titles/artists (backend, additive via trackMatchIds) — then by
  // kind, then sort by the user's chain (comparePlaylists falls back to the
  // class ranking, so an empty chain keeps system → auto → user).
  const q = searchQuery.trim().toLowerCase();
  const filtered = (q
    ? playlists.filter((p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description?.toLowerCase().includes(q) ?? false) ||
        trackMatchIds.has(p.id))
    : playlists
  )
    .filter((p) => kindFilter === "all" || playlistKind(p) === kindFilter)
    .slice()
    .sort((a, b) => comparePlaylists(a, b, sortChain));

  const deleteModal = deleteConfirm && (
    <DeletePlaylistModal
      playlistName={deleteConfirm.name}
      onConfirm={handleDeleteConfirm}
      onClose={() => setDeleteConfirm(null)}
    />
  );

  const folderErrorModal = folderError && (
    <div className="ds-modal-overlay">
      <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="ds-modal-title">Open Containing Folder</h2>
        <p className="delete-confirm-warning">{folderError}</p>
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={() => setFolderError(null)}>OK</button>
        </div>
      </div>
    </div>
  );

  // Detail view
  if (selectedPlaylist) {
    const filtering = displayTracks.length !== tracks.length;
    const detailMeta: string[] = [
      filtering
        ? `${displayTracks.length} of ${tracks.length} tracks`
        : `${tracks.length} ${tracks.length === 1 ? "track" : "tracks"}`,
    ];
    if (isAuto(selectedPlaylist)) detailMeta.push(`Updated ${formatDate(selectedPlaylist.saved_at)}`);
    else if (!selectedPlaylist.system_kind) detailMeta.push(`Saved ${formatDate(selectedPlaylist.saved_at)}`);

    // Prefer a user-authored description; otherwise describe the playlist by its
    // most-featured artists (top 3-4 by track count) so no playlist is blank.
    const featured = featuredArtists(tracks, 4);
    const detailDescription = selectedPlaylist.description?.trim()
      || (featured.length > 0 ? `Featuring ${featured.join(", ")}` : undefined);

    const detailOverflowItems: HeroOverflowItem[] = [];
    if (editable) {
      const playlistId = selectedPlaylist.id;
      detailOverflowItems.push({ kind: "action", id: "edit-details", label: "Edit details…", onClick: () => setEditDetails(true) });
      // Same labels/icons/order as every other detail hero. No "Retrieve image"
      // or "Search image": a playlist is a user's own list, so there is no
      // provider chain to re-fetch a cover from and nothing to search for.
      detailOverflowItems.push(...buildHeroOverflowItems({
        entityKind: "playlist",
        imageActions: {
          onSetFromFile: () => handleSetCoverFromFile(playlistId),
          onPasteFromClipboard: () => handlePasteCover(playlistId),
          onRemove: selectedPlaylist.image_path ? () => { void applyCover(playlistId, null); } : undefined,
        },
        pluginItems: [],
      }));
      detailOverflowItems.push({ kind: "divider" });
    }
    detailOverflowItems.push(
      { kind: "action", id: "export-m3u", label: "Export as M3U", onClick: () => handleExport(selectedPlaylist) },
    );
    if (onExportAsMixtape) {
      detailOverflowItems.push({
        kind: "action", id: "export-mixtape", label: "Export as Mixtape",
        onClick: () => {
          if (tracks.length === 0) return;
          const meta = parsePlaylistMetadata(selectedPlaylist.metadata);
          onExportAsMixtape(tracks.map(t => ({
            title: t.title,
            artistName: t.artist_name || undefined,
            albumTitle: t.album_name || undefined,
            durationSecs: t.duration_secs || undefined,
            path: t.source || undefined,
            imageUrl: t.image_path || undefined,
          })), selectedPlaylist.name, selectedPlaylist.image_path, meta);
        },
      });
    }
    if (isAuto(selectedPlaylist)) {
      detailOverflowItems.push({ kind: "divider" });
      detailOverflowItems.push({ kind: "action", id: "refresh", label: "Refresh mixes", onClick: () => handleRefreshAuto() });
    }
    if (!isProtectedSystem(selectedPlaylist)) {
      detailOverflowItems.push({ kind: "divider" });
      detailOverflowItems.push({ kind: "action", id: "delete", label: "Delete playlist", danger: true, onClick: () => setDeleteConfirm(selectedPlaylist) });
    }

    // Cover: the playlist's own image if set, else (for auto mixes) the first
    // artist's image. The latter also seeds the hero background when there are
    // no resolved track images to collage.
    const autoArtist = isAuto(selectedPlaylist) ? firstArtist(selectedPlaylist.metadata) : null;
    const autoArtistImg = autoArtist ? artistImages.getImage(autoArtist) : null;
    // resolveImageUrl handles the entity cache's #v=N cache-buster (→ ?v=N).
    const autoArtistSrc = resolveImageUrl(autoArtistImg);
    const detailArtSrc = selectedPlaylist.image_path
      ? imageUrl(selectedPlaylist.image_path)
      : autoArtistSrc ?? playlistDefault;
    const detailBgImages = heroBgImages.length > 0
      ? heroBgImages
      : autoArtistSrc ? [autoArtistSrc] : [];

    // Liked / Disliked Tracks carry no image_path; give them the same branded
    // gradient + icon cover as their list shortcut instead of the generic disc.
    const detailArt = isProtectedSystem(selectedPlaylist) && !selectedPlaylist.image_path ? (
      <div className={`playlist-hero-system-cover playlist-hero-system-cover--${selectedPlaylist.system_kind}`}>
        {selectedPlaylist.system_kind === "liked"
          ? <IconHeartFilled size={88} />
          : <IconBan size={88} />}
      </div>
    ) : (
      <img src={detailArtSrc} alt={selectedPlaylist.name} />
    );

    const playOne = (t: PlaylistTrack) => onPlayTracks([playlistTrackToMinimalTrack(t)], 0, playlistContext(selectedPlaylist));
    const enqueueOne = (t: PlaylistTrack) => onEnqueueTracks([playlistTrackToMinimalTrack(t)]);
    // Tile art: the shared render-time chain already yields a ready-to-render
    // URL (explicit image → video frame → album → artist), so hand it to the
    // card's direct-url shape; first letter when nothing resolves.
    const cardArt = (t: PlaylistTrack): TrackCardArt => {
      const url = resolvedTrackImage(t);
      return url ? { kind: "image", url, alt: t.title } : { kind: "letter", text: t.title[0]?.toUpperCase() ?? "?" };
    };
    const tracksEmptyMessage = tracks.length === 0 ? "This playlist is empty." : "No matching tracks.";

    return (
      <div className="playlists-view">
        <DetailHero
          bgImages={detailBgImages}
          onBack={goBack}
          art={detailArt}
          artShape="square"
          eyebrow={isAuto(selectedPlaylist) ? "Made for you" : selectedPlaylist.system_kind ? "System playlist" : "Playlist"}
          title={selectedPlaylist.name}
          entityLabel="album"
          meta={detailMeta}
          description={detailDescription}
          onPlay={displayTracks.length > 0 ? () => onPlayTracks(displayTracks.map(playlistTrackToMinimalTrack), 0, playlistContext(selectedPlaylist)) : undefined}
          onEnqueue={displayTracks.length > 0 ? () => onEnqueueTracks(displayTracks.map(playlistTrackToMinimalTrack)) : undefined}
          overflowItems={detailOverflowItems}
        />
        <ViewSearchBar
          query={trackQuery}
          onQueryChange={setTrackQuery}
          placeholder="Search this playlist..."
        >
          <div className="playlist-detail-toolbar">
            <button className="sort-btn sort-bar-toggle" onClick={() => setTrackSortBarCollapsed(v => !v)} title={trackSortBarCollapsed ? "Show sort bar" : "Hide sort bar"}>{trackSortBarCollapsed ? "▼" : "▲"}</button>
            <ViewModeToggle mode={trackViewMode} onChange={setTrackViewMode} />
          </div>
        </ViewSearchBar>
        <div className={`sort-bar-wrapper${trackSortBarCollapsed ? " collapsed" : ""}`}>
          <div className="sort-bar">
            <div className="sort-bar-row">
              <span className="sort-bar-label">Sort:</span>
              <div className="sort-bar-group">
                <SortButton label="#" field="position" chain={trackSortChain} onClick={handleTrackSortClick} />
                <SortButton label="Title" field="title" chain={trackSortChain} onClick={handleTrackSortClick} />
                <SortButton label="Artist" field="artist" chain={trackSortChain} onClick={handleTrackSortClick} />
                <SortButton label="Album" field="album" chain={trackSortChain} onClick={handleTrackSortClick} />
                <SortButton label="Duration" field="duration" chain={trackSortChain} onClick={handleTrackSortClick} />
                <SortButton label={"♥ Liked"} field="liked" chain={trackSortChain} onClick={handleTrackSortClick} />
                <SortButton label="Shuffle" field="random" chain={trackSortChain} onClick={handleTrackSortClick} />
                {trackSortChain.length >= 1 && (
                  <button className="sort-btn sort-btn-clear" onClick={() => setTrackSortChain([])}>Clear</button>
                )}
              </div>
            </div>
            <div className="sort-bar-row">
              <span className="sort-bar-label">Filter:</span>
              <div className="sort-bar-group sort-bar-group-filter">
                <button className={`sort-btn${trackMediaFilter === "all" ? " active" : ""}`} onClick={() => setTrackMediaFilter("all")}>All</button>
                <button className={`sort-btn${trackMediaFilter === "audio" ? " active" : ""}`} onClick={() => setTrackMediaFilter("audio")}>Audio</button>
                <button className={`sort-btn${trackMediaFilter === "video" ? " active" : ""}`} onClick={() => setTrackMediaFilter("video")}>Video</button>
              </div>
            </div>
          </div>
        </div>
        {trackViewMode === "basic" ? (
          <div className="entity-table playlists-track-list">
            <div className="entity-table-header">
              {onToggleLike && <span className="entity-table-like"></span>}
              <span className={`pl-track-num sortable${chainDir(trackSortChain, "position") ? " sorted" : ""}`} onClick={(e) => handleTrackSortClick("position", e)} title="Playlist order">#{trackSortIndicator("position")}</span>
              <span className={`entity-table-name sortable${chainDir(trackSortChain, "title") ? " sorted" : ""}`} onClick={(e) => handleTrackSortClick("title", e)}>Title{trackSortIndicator("title")}</span>
              <span className={`entity-table-secondary sortable${chainDir(trackSortChain, "artist") ? " sorted" : ""}`} onClick={(e) => handleTrackSortClick("artist", e)}>Artist{trackSortIndicator("artist")}</span>
              <span className={`entity-table-secondary sortable${chainDir(trackSortChain, "album") ? " sorted" : ""}`} onClick={(e) => handleTrackSortClick("album", e)}>Album{trackSortIndicator("album")}</span>
              <span className={`entity-table-count sortable${chainDir(trackSortChain, "duration") ? " sorted" : ""}`} onClick={(e) => handleTrackSortClick("duration", e)}>Time{trackSortIndicator("duration")}</span>
            </div>
            {displayTracks.map((t, index) => (
              <div
                key={t.id}
                data-pl-index={index}
                className={`entity-table-row${selectedTrackIds.has(t.id) ? " selected" : ""}${reorderInsertIndex === index ? " pl-reorder-before" : ""}${reorderInsertIndex === index + 1 && index === displayTracks.length - 1 ? " pl-reorder-after" : ""}`}
                onClick={(e) => handleRowClick(e, index)}
                onMouseDown={(e) => handleRowMouseDown(e, index)}
                onDoubleClick={() => { setSelectedTrackIds(new Set()); playOne(t); }}
                onContextMenu={(e) => showTrackMenu(e, t)}
              >
                {onToggleLike && (
                  <LikeDislikeButtons
                    liked={t.liked ?? 0}
                    onToggleLike={() => rateTrack(t, "like")}
                    onToggleDislike={onToggleDislike ? () => rateTrack(t, "dislike") : undefined}
                    variant="inline"
                    size={12}
                  />
                )}
                <span className="pl-track-num">{t.position + 1}</span>
                <span className="entity-table-name">
                  <span className="entity-table-name-main">{t.title}</span>
                  <EntityRowActions
                    onPlay={() => playOne(t)}
                    onEnqueue={() => enqueueOne(t)}
                    onDetails={() => onLocateTrack?.(t.title, t.artist_name, t.album_name)}
                  />
                </span>
                <span className="entity-table-secondary">{t.artist_name ?? "Unknown"}</span>
                <span className="entity-table-secondary">{t.album_name ?? ""}</span>
                <span className="entity-table-count">{formatDuration(t.duration_secs)}</span>
              </div>
            ))}
            {displayTracks.length === 0 && <div className="empty">{tracksEmptyMessage}</div>}
          </div>
        ) : trackViewMode === "tiles" ? (
          <div className="tiles-scroll">
            <div className="entity-grid playlists-track-list">
              {displayTracks.map((t, index) => (
                <TrackCard
                  key={t.id}
                  art={cardArt(t)}
                  title={t.title}
                  subtitle={<>{t.artist_name && <>{t.artist_name} {"·"} </>}{formatDuration(t.duration_secs)}</>}
                  liked={t.liked ?? 0}
                  selected={selectedTrackIds.has(t.id)}
                  onClick={(e) => handleRowClick(e, index)}
                  onMouseDown={(e) => handleRowMouseDown(e, index)}
                  onDoubleClick={() => { setSelectedTrackIds(new Set()); playOne(t); }}
                  onContextMenu={(e) => showTrackMenu(e, t)}
                  onPlay={() => playOne(t)}
                  onLocate={() => onLocateTrack?.(t.title, t.artist_name, t.album_name)}
                  onToggleLike={() => rateTrack(t, "like")}
                  onToggleDislike={onToggleDislike ? () => rateTrack(t, "dislike") : undefined}
                />
              ))}
              {displayTracks.length === 0 && <div className="empty">{tracksEmptyMessage}</div>}
            </div>
          </div>
        ) : (
          <div className="entity-list playlists-track-list">
            {displayTracks.map((t, index) => (
              <TrackRow
                key={t.id}
                dataAttrs={{ "data-pl-index": index }}
                className={`${reorderInsertIndex === index ? "pl-reorder-before" : ""}${reorderInsertIndex === index + 1 && index === displayTracks.length - 1 ? " pl-reorder-after" : ""}`}
                thumb={trackThumb(t)}
                leading={
                  <>
                    <span className="pl-track-num">{t.position + 1}</span>
                    {onToggleLike && (
                      <LikeDislikeButtons
                        liked={t.liked ?? 0}
                        onToggleLike={() => rateTrack(t, "like")}
                        onToggleDislike={onToggleDislike ? () => rateTrack(t, "dislike") : undefined}
                        variant="inline"
                        size={12}
                      />
                    )}
                  </>
                }
                title={t.title}
                selected={selectedTrackIds.has(t.id)}
                onClick={(e) => handleRowClick(e, index)}
                onMouseDown={(e) => handleRowMouseDown(e, index)}
                onDoubleClick={() => { setSelectedTrackIds(new Set()); playOne(t); }}
                onContextMenu={(e) => showTrackMenu(e, t)}
                subtitle={<>{t.artist_name ?? "Unknown"}{t.album_name ? <> {"·"} {t.album_name}</> : null}</>}
                meta={formatDuration(t.duration_secs)}
                actions={{
                  onPlay: () => playOne(t),
                  onEnqueue: () => enqueueOne(t),
                  onStartRadio: onStartRadio ? () => onStartRadio({ title: t.title, artistName: t.artist_name, coverPath: rawTrackImagePath(t) }) : undefined,
                  onDetails: onLocateTrack ? () => onLocateTrack(t.title, t.artist_name, t.album_name) : undefined,
                }}
              />
            ))}
            {displayTracks.length === 0 && <div className="empty">{tracksEmptyMessage}</div>}
          </div>
        )}
        {folderErrorModal}
        {deleteModal}
        {editTrack && (
          <EditTrackMetadataModal
            defaultTitle={editTrack.title}
            defaultArtist={editTrack.artist_name ?? ""}
            defaultAlbum={editTrack.album_name ?? ""}
            info={buildTrackInfoEntries({
              position: editTrack.position + 1,
              durationSecs: editTrack.duration_secs,
              source: editTrack.source,
              imageUrl: editTrack.image_path,
              liked: editTrack.liked,
            })}
            onSave={handleEditTrackSave}
            onClose={() => setEditTrack(null)}
          />
        )}
        {editDetails && (
          <SavePlaylistModal
            title="Edit Playlist"
            defaultName={selectedPlaylist.name}
            defaultImage={selectedPlaylist.image_path}
            withDescription
            defaultDescription={selectedPlaylist.description}
            onSave={handleEditDetailsSave}
            onClose={() => setEditDetails(false)}
          />
        )}
      </div>
    );
  }

  // List view
  const protectedSystem = filtered.filter(isProtectedSystem);
  const autoPlaylists = filtered.filter(isAuto);
  const regularPlaylists = filtered.filter((p) => !p.system_kind);

  const emptyMessage = searchQuery.trim() || kindFilter !== "all"
    ? "No matching playlists"
    : "No saved playlists yet — play some tracks, then use Save → Save as Playlist in the queue panel.";

  const playGlyph = (
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg>
  );

  // Row thumbnail for the flat list mode: the system playlists' branded
  // gradient cover, else the same cover the tile cards resolve.
  const rowCover = (pl: Playlist) => {
    if (isProtectedSystem(pl) && !pl.image_path) {
      return (
        <div className="entity-list-img">
          <div className={`playlist-hero-system-cover playlist-hero-system-cover--${pl.system_kind}`}>
            {pl.system_kind === "liked" ? <IconHeartFilled size={18} /> : <IconBan size={18} />}
          </div>
        </div>
      );
    }
    const src = isAuto(pl) ? autoCoverSrc(pl) : (pl.image_path ? imageUrl(pl.image_path) : playlistDefault);
    return <div className="entity-list-img"><img src={src} alt="" /></div>;
  };

  // The "Made for you" section is shown even with zero mixes (as long as the
  // search/filter isn't deliberately hiding it), because its header carries the
  // only control that forces generation. Hiding it when empty made the empty
  // state a dead end: the 24h throttle in App.tsx means the automatic refresh
  // may not try again for a day.
  const showAutoSection =
    autoPlaylists.length > 0 ||
    (!searchQuery.trim() && (kindFilter === "all" || kindFilter === "auto"));

  const refreshButton = (
    <button
      className="ds-btn ds-btn--ghost ds-btn--sm"
      onClick={handleRefreshAuto}
      disabled={refreshingAuto}
      title={autoPlaylists.length > 0 ? "Regenerate your mixes" : "Generate your mixes now"}
    >
      {refreshingAuto ? <span className="ds-spinner ds-spinner--sm" /> : <IconRefresh size={15} />}
      {autoPlaylists.length > 0 ? "Refresh" : "Generate mixes"}
    </button>
  );

  return (
    <>
      <ViewSearchBar
        query={searchQuery}
        onQueryChange={onSearchChange}
        placeholder="Search playlists..."
      />
      <div className="ds-tabs" style={{ padding: "0 16px", gap: 4 }}>
        <div style={{ display: "flex", flex: 1, alignItems: "center" }}>
          {/* In tiles mode the "Made for you" section header carries Refresh;
              the flat modes have no sections, so it lives up here instead. */}
          {viewMode !== "tiles" && showAutoSection && refreshButton}
        </div>
        <button className="sort-btn sort-bar-toggle" onClick={() => setSortBarCollapsed(v => !v)} title={sortBarCollapsed ? "Show sort bar" : "Hide sort bar"}>{sortBarCollapsed ? "▼" : "▲"}</button>
        <ViewModeToggle mode={viewMode} onChange={setViewMode} />
      </div>
      <div className={`sort-bar-wrapper${sortBarCollapsed ? " collapsed" : ""}`}>
        <div className="sort-bar">
          <div className="sort-bar-row">
            <span className="sort-bar-label">Sort:</span>
            <div className="sort-bar-group">
              <SortButton label="Name" field="name" chain={sortChain} onClick={handleSortClick} />
              <SortButton label="Tracks" field="tracks" chain={sortChain} onClick={handleSortClick} />
              <SortButton label="Updated" field="updated" chain={sortChain} onClick={handleSortClick} />
              {sortChain.length >= 1 && (
                <button className="sort-btn sort-btn-clear" onClick={() => setSortChain([])}>Clear</button>
              )}
            </div>
          </div>
          <div className="sort-bar-row">
            <span className="sort-bar-label">Filter:</span>
            <div className="sort-bar-group sort-bar-group-filter">
              <button className={`sort-btn${kindFilter === "all" ? " active" : ""}`} onClick={() => setKindFilter("all")}>All</button>
              <button className={`sort-btn${kindFilter === "auto" ? " active" : ""}`} onClick={() => setKindFilter("auto")}>Made for you</button>
              <button className={`sort-btn${kindFilter === "user" ? " active" : ""}`} onClick={() => setKindFilter("user")}>Saved</button>
              <button className={`sort-btn${kindFilter === "system" ? " active" : ""}`} onClick={() => setKindFilter("system")}>System</button>
            </div>
          </div>
        </div>
      </div>
      <div className="playlists-view">
      {filtered.length === 0 && !(viewMode === "tiles" && showAutoSection) ? (
        <div className="playlists-empty ds-empty">{emptyMessage}</div>
      ) : viewMode === "list" ? (
        <div className="entity-list">
          {filtered.map((pl) => (
            <div key={pl.id} className="entity-list-item" onClick={() => openPlaylist(pl)} onContextMenu={(e) => handleContextMenu(e, pl)}>
              <div className="entity-list-content">
                {rowCover(pl)}
                <div className="entity-list-info">
                  <span className="entity-list-name">{pl.name}</span>
                  <span className="entity-list-secondary">
                    {playlistKindLabel(playlistKind(pl))} {"·"} {pl.track_count} tracks {"·"} {formatDate(pl.saved_at)}
                  </span>
                </div>
              </div>
              <EntityRowActions
                onPlay={() => playPlaylist(pl).catch((err) => console.error("Failed to play playlist:", err))}
                onEnqueue={() => handleEnqueuePlaylist(pl)}
                onDetails={() => openPlaylist(pl)}
              />
            </div>
          ))}
        </div>
      ) : viewMode === "basic" ? (
        <div className="entity-table">
          <div className="entity-table-header">
            <span className={`entity-table-name sortable${chainDir(sortChain, "name") ? " sorted" : ""}`} onClick={() => handleSortClick("name")}>Name{sortIndicator("name")}</span>
            <span className="entity-table-secondary">Kind</span>
            <span className={`entity-table-count sortable${chainDir(sortChain, "tracks") ? " sorted" : ""}`} onClick={() => handleSortClick("tracks")}>Tracks{sortIndicator("tracks")}</span>
            <span className={`playlist-table-date sortable${chainDir(sortChain, "updated") ? " sorted" : ""}`} onClick={() => handleSortClick("updated")}>Updated{sortIndicator("updated")}</span>
          </div>
          {filtered.map((pl) => (
            <div key={pl.id} className="entity-table-row" onClick={() => openPlaylist(pl)} onContextMenu={(e) => handleContextMenu(e, pl)}>
              <span className="entity-table-name">
                <span className="entity-table-name-main">{pl.name}</span>
                <EntityRowActions
                  onPlay={() => playPlaylist(pl).catch((err) => console.error("Failed to play playlist:", err))}
                  onEnqueue={() => handleEnqueuePlaylist(pl)}
                  onDetails={() => openPlaylist(pl)}
                />
              </span>
              <span className="entity-table-secondary">{playlistKindLabel(playlistKind(pl))}</span>
              <span className="entity-table-count">{pl.track_count}</span>
              <span className="playlist-table-date">{formatDate(pl.saved_at)}</span>
            </div>
          ))}
        </div>
      ) : (
        <>
          {protectedSystem.length > 0 && (
            <div className="playlist-shortcuts">
              {protectedSystem.map((pl) => (
                <div
                  key={pl.id}
                  className={`playlist-shortcut playlist-shortcut--${pl.system_kind}`}
                  onClick={() => openPlaylist(pl)}
                  onContextMenu={(e) => handleContextMenu(e, pl)}
                >
                  <div className="playlist-shortcut-art">
                    {pl.system_kind === "liked"
                      ? <IconHeartFilled size={26} />
                      : <IconBan size={26} />}
                  </div>
                  <div className="playlist-shortcut-name">{pl.name}</div>
                  <button className="playlist-shortcut-play" onClick={(e) => handlePlayPlaylist(e, pl)} title="Play">
                    {playGlyph}
                  </button>
                </div>
              ))}
            </div>
          )}
          {showAutoSection && (
            <div className="playlists-section">
              <div className="playlists-section-header">
                <h3 className="playlists-section-title">Made for you</h3>
                {refreshButton}
              </div>
              {autoPlaylists.length === 0 && (
                <div className="playlists-section-empty ds-empty">
                  No mixes right now. They rebuild on their own about once a day —
                  use Generate mixes to build them from your library now.
                </div>
              )}
              <div className="playlists-grid">
                {autoPlaylists.map((pl) => {
                  // Spotify-"Daily Mix"-style description: the mix's top artists,
                  // recorded in metadata at generation. Falls back to the track
                  // count + last-refresh line for legacy mixes (pre-regeneration).
                  const artistsLabel = featuredArtistsLabel(featuredArtistsFromMetadata(pl.metadata));
                  return (
                  <div key={pl.id} className="playlist-card" onClick={() => openPlaylist(pl)} onContextMenu={(e) => handleContextMenu(e, pl)}>
                    <div className="playlist-card-art">
                      <img src={autoCoverSrc(pl)} alt="" />
                      <span className="playlist-card-auto-badge" title={autoRecipeLabel(parseRecipe(pl.metadata))}>
                        <IconSparkles size={13} />
                      </span>
                      <button className="playlist-card-more" onClick={(e) => handleMoreClick(e, pl)} title="More options">&#x22EF;</button>
                      <button className="ds-card-play" onClick={(e) => handlePlayPlaylist(e, pl)} title="Play">
                        {playGlyph}
                      </button>
                    </div>
                    <div className="playlist-card-info">
                      <div className="playlist-card-name">{pl.name}</div>
                    </div>
                    <div className="playlist-card-meta">
                      {artistsLabel ?? `${pl.track_count} tracks · Updated ${formatDate(pl.saved_at)}`}
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>
          )}
          {regularPlaylists.length > 0 && (
            <div className="playlists-section">
              <div className="playlists-section-header">
                <h3 className="playlists-section-title">Saved playlists</h3>
              </div>
              <div className="playlists-grid">
                {regularPlaylists.map((pl) => (
                  <div key={pl.id} className="playlist-card" onClick={() => openPlaylist(pl)} onContextMenu={(e) => handleContextMenu(e, pl)}>
                    <div className="playlist-card-art">
                      <img src={pl.image_path ? imageUrl(pl.image_path) : playlistDefault} alt="" />
                      <button className="playlist-card-more" onClick={(e) => handleMoreClick(e, pl)} title="More options">&#x22EF;</button>
                      <button className="ds-card-play" onClick={(e) => handlePlayPlaylist(e, pl)} title="Play">
                        {playGlyph}
                      </button>
                    </div>
                    <div className="playlist-card-info">
                      <div className="playlist-card-name">{pl.name}</div>
                    </div>
                    <div className="playlist-card-meta">
                      {`${pl.track_count} tracks · ${formatDate(pl.saved_at)}`}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      {deleteModal}
      </div>
    </>
  );
}
