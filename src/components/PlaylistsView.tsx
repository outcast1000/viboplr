import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { subscribe, combineUnlisten } from "../utils/tauriEvents";
import { formatDuration } from "../utils";
import { save } from "@tauri-apps/plugin-dialog";
import { DeletePlaylistModal } from "./DeletePlaylistModal";
import type { PluginMenuItem, PluginContextMenuTarget } from "../types/plugin";
import type { PlaylistContext } from "../hooks/useQueue";
import type { QueueTrack } from "../types";
import { nextExternalKey } from "../queueEntry";
import type { ExportTrack } from "./MixtapeExportModal";
import { showNativeMenu, type MenuItemSpec } from "../nativeMenu";
import { DetailHero } from "./DetailHero";
import { TrackRow, type TrackRowThumb } from "./TrackRow";
import { ViewSearchBar } from "./ViewSearchBar";
import type { HeroOverflowItem } from "../utils/heroOverflow";
import playlistDefault from "../assets/playlist-default.png";
import { resolveImageUrl } from "../utils/resolveImageUrl";
import { IconHeartFilled, IconThumbsDownFilled, IconRefresh, IconSparkles } from "./Icons";
import { LikeDislikeButtons } from "./LikeDislikeButtons";
import { nextTriState } from "../likeKeys";
import { isAuto, isProtectedSystem, playlistRank, parseRecipe, autoRecipeLabel, firstArtist, featuredArtists, featuredArtistsFromMetadata, featuredArtistsLabel } from "../utils/autoPlaylist";
import { useImageCache } from "../hooks/useImageCache";
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


function playlistTrackToMinimalTrack(t: PlaylistTrack): QueueTrack {
  return {
    key: nextExternalKey(),
    path: t.source ?? null,
    title: t.title,
    artist_name: t.artist_name,
    album_title: t.album_name,
    duration_secs: t.duration_secs ?? null,
    format: null,
    image_url: t.image_path ?? undefined,
    liked: t.liked ?? 0,
  };
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
}

function isLocalPath(source: string | null): boolean {
  return !!source && source.startsWith("file://");
}

// Index-based multi-select over the detail track rows, keyed by playlist-track
// id. Mirrors TrackList's computeSelection: shift = range, meta = toggle, plain
// = single.
function computeRowSelection(
  current: Set<number>,
  clickedIndex: number,
  ids: number[],
  lastIndex: number | null,
  meta: boolean,
  shift: boolean,
): Set<number> {
  if (shift) {
    const start = lastIndex ?? 0;
    const lo = Math.min(start, clickedIndex);
    const hi = Math.max(start, clickedIndex);
    const range = new Set(ids.slice(lo, hi + 1));
    if (meta) {
      const merged = new Set(current);
      for (const id of range) merged.add(id);
      return merged;
    }
    return range;
  }
  if (meta) {
    const next = new Set(current);
    const id = ids[clickedIndex];
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }
  return new Set([ids[clickedIndex]]);
}

export function PlaylistsView({ searchQuery, onSearchChange, onPlayTracks, onEnqueueTracks, onStartRadio, onLocateTrack, onExportAsMixtape, pluginMenuItems, onPluginAction, onTrackDragStart, onToggleLike, onToggleDislike }: PlaylistsViewProps) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<PlaylistTrack[]>([]);
  const [deleteConfirm, setDeleteConfirm] = useState<Playlist | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [refreshingAuto, setRefreshingAuto] = useState(false);
  // Detail-view multi-select (by playlist-track id) + drag-to-queue handshake.
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<number>>(new Set());
  const lastClickedTrackRef = useRef<number | null>(null);
  const didDragRef = useRef(false);
  const artistImages = useImageCache("artist");
  const albumImages = useImageCache("album");

  // Build the queue's PlaylistContext. Auto-playlists ("Made for you") store no
  // image_path, so fall back to the mix's first-artist image — the same raw path
  // autoCoverSrc resolves for the card — otherwise the queue banner cover is blank.
  const playlistContext = useCallback((pl: Playlist): PlaylistContext => {
    const metadata: Record<string, string> | null = pl.metadata ? JSON.parse(pl.metadata) : null;
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
      const states = await invoke<number[]>("get_track_like_states", {
        tracks: rows.map(t => ({ title: t.title, artistName: t.artist_name })),
      });
      return rows.map((t, i) => ({ ...t, liked: states[i] ?? 0 }));
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
      await loadPlaylists();
    } catch (e) {
      console.error("Failed to refresh auto playlists:", e);
    } finally {
      setRefreshingAuto(false);
    }
  }, [loadPlaylists]);

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
    lastClickedTrackRef.current = null;
    setTracks(await loadPlaylistTracks(pl.id));
  }, [loadPlaylistTracks]);

  const goBack = useCallback(() => {
    setSelectedPlaylist(null);
    setTracks([]);
    setSelectedTrackIds(new Set());
    lastClickedTrackRef.current = null;
  }, []);

  // Left-click selection over the detail rows (Cmd/Ctrl = toggle, Shift = range).
  // Suppressed right after a drag and when the click lands on a hover-tray button.
  const handleRowClick = useCallback((e: React.MouseEvent, index: number) => {
    if (didDragRef.current) return;
    if ((e.target as HTMLElement).closest(".row-hover-action")) return;
    const ids = tracks.map(t => t.id);
    setSelectedTrackIds(prev => computeRowSelection(prev, index, ids, lastClickedTrackRef.current, e.metaKey || e.ctrlKey, e.shiftKey));
    lastClickedTrackRef.current = index;
  }, [tracks]);

  // Drag-to-queue: past a 5px threshold, hand the dragged tracks (the whole
  // selection if the pressed row is part of a multi-selection, else just it) to
  // the shared queue drag handshake.
  const handleRowMouseDown = useCallback((e: React.MouseEvent, index: number) => {
    if (e.button !== 0 || !onTrackDragStart) return;
    if ((e.target as HTMLElement).closest(".row-hover-action")) return;
    const startX = e.clientX, startY = e.clientY;
    didDragRef.current = false;
    const onMove = (ev: MouseEvent) => {
      if (didDragRef.current) return;
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 5) return;
      didDragRef.current = true;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const clicked = tracks[index];
      const source = (selectedTrackIds.has(clicked.id) && selectedTrackIds.size > 1)
        ? tracks.filter(t => selectedTrackIds.has(t.id))
        : [clicked];
      onTrackDragStart(source.map(playlistTrackToMinimalTrack));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [tracks, selectedTrackIds, onTrackDragStart]);

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

  const handlePlayPlaylist = useCallback(async (e: React.MouseEvent, pl: Playlist) => {
    e.stopPropagation();
    const rows = await loadPlaylistTracks(pl.id);
    if (rows.length > 0) {
      onPlayTracks(rows.map(playlistTrackToMinimalTrack), 0, playlistContext(pl));
    }
  }, [onPlayTracks, playlistContext, loadPlaylistTracks]);

  const handleEnqueuePlaylist = useCallback(async (pl: Playlist) => {
    const rows = await loadPlaylistTracks(pl.id);
    if (rows.length > 0) {
      onEnqueueTracks(rows.map(playlistTrackToMinimalTrack));
    }
  }, [onEnqueueTracks, loadPlaylistTracks]);

  const showPlaylistMenu = useCallback(async (x: number, y: number, pl: Playlist) => {
    const specs: MenuItemSpec[] = [
      { kind: "item", text: "Play", action: () => handlePlayPlaylist({ stopPropagation: () => {} } as React.MouseEvent, pl) },
      { kind: "item", text: "Enqueue", action: () => handleEnqueuePlaylist(pl) },
      { kind: "item", text: "View / Edit", action: () => openPlaylist(pl) },
      { kind: "separator" },
      { kind: "item", text: "Export as M3U", action: () => handleExport(pl) },
    ];
    if (onExportAsMixtape) {
      specs.push({ kind: "item", text: "Export as Mixtape", action: async () => {
        try {
          const rows = await invoke<PlaylistTrack[]>("get_playlist_tracks", { playlistId: pl.id });
          if (rows.length === 0) return;
          const meta = pl.metadata ? JSON.parse(pl.metadata) as Record<string, string> : null;
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
  }, [handlePlayPlaylist, handleEnqueuePlaylist, openPlaylist, handleExport, onExportAsMixtape, pluginMenuItems, onPluginAction]);

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

  // Per-track artwork via the live entity-image chain: album image → artist
  // image. getImage requests a fetch on a disk miss and the *-image-ready events
  // refresh the cache, so a row that started on the artist fallback upgrades to
  // the album cover once it's retrieved (and a missing image still gets
  // requested). Mirrors the Home shelf / queue chains — unlike the old
  // resolve-once pass, which read get_entity_image directly (disk-only, never
  // fetched, never upgraded).
  const trackImagePath = useCallback((t: PlaylistTrack): string | null => {
    if (t.image_path) return t.image_path;
    return (t.album_name ? albumImages.getImage(t.album_name, t.artist_name ?? null) : null)
      ?? (t.artist_name ? artistImages.getImage(t.artist_name) : null);
  }, [albumImages, artistImages]);

  // Per-row thumbnail. Falls back to the shared disc placeholder (the same
  // default every other track surface uses — Library list, queue, history) when
  // no album/artist art resolves, rather than the playlist cover image.
  const trackThumb = useCallback((t: PlaylistTrack): TrackRowThumb => {
    const url = resolveImageUrl(trackImagePath(t));
    return url ? { kind: "image", url } : { kind: "disc" };
  }, [trackImagePath]);

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
      const u = resolveImageUrl(trackImagePath(t));
      if (!u || seen.has(u)) continue;
      seen.add(u);
      out.push(u);
      if (out.length === 4) break;
    }
    return out;
  }, [selectedPlaylist, tracks, trackImagePath, imageUrl]);

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

  // Filter by search query: playlist name + description (client-side, instant) and
  // track titles/artists (backend, via trackMatchIds).
  const q = searchQuery.trim().toLowerCase();
  const filtered = (q
    ? playlists.filter((p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description?.toLowerCase().includes(q) ?? false) ||
        trackMatchIds.has(p.id))
    : playlists
  ).slice().sort((a, b) => playlistRank(a) - playlistRank(b));

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
    const detailMeta: string[] = [
      `${tracks.length} ${tracks.length === 1 ? "track" : "tracks"}`,
    ];
    if (isAuto(selectedPlaylist)) detailMeta.push(`Updated ${formatDate(selectedPlaylist.saved_at)}`);
    else if (!selectedPlaylist.system_kind) detailMeta.push(`Saved ${formatDate(selectedPlaylist.saved_at)}`);

    // Prefer a user-authored description; otherwise describe the playlist by its
    // most-featured artists (top 3-4 by track count) so no playlist is blank.
    const featured = featuredArtists(tracks, 4);
    const detailDescription = selectedPlaylist.description?.trim()
      || (featured.length > 0 ? `Featuring ${featured.join(", ")}` : undefined);

    const detailOverflowItems: HeroOverflowItem[] = [
      { kind: "action", id: "export-m3u", label: "Export as M3U", onClick: () => handleExport(selectedPlaylist) },
    ];
    if (onExportAsMixtape) {
      detailOverflowItems.push({
        kind: "action", id: "export-mixtape", label: "Export as Mixtape",
        onClick: () => {
          if (tracks.length === 0) return;
          const meta = selectedPlaylist.metadata ? JSON.parse(selectedPlaylist.metadata) as Record<string, string> : null;
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
          : <IconThumbsDownFilled size={88} />}
      </div>
    ) : (
      <img src={detailArtSrc} alt={selectedPlaylist.name} />
    );

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
          onPlay={tracks.length > 0 ? () => onPlayTracks(tracks.map(playlistTrackToMinimalTrack), 0, playlistContext(selectedPlaylist)) : undefined}
          onEnqueue={tracks.length > 0 ? () => onEnqueueTracks(tracks.map(playlistTrackToMinimalTrack)) : undefined}
          overflowItems={detailOverflowItems}
        />
        <div className="entity-list playlists-track-list">
          {tracks.map((t, index) => (
            <TrackRow
              key={t.id}
              thumb={trackThumb(t)}
              leading={onToggleLike ? (
                <LikeDislikeButtons
                  liked={t.liked ?? 0}
                  onToggleLike={() => rateTrack(t, "like")}
                  onToggleDislike={onToggleDislike ? () => rateTrack(t, "dislike") : undefined}
                  variant="inline"
                  size={12}
                />
              ) : undefined}
              title={t.title}
              selected={selectedTrackIds.has(t.id)}
              onClick={(e) => handleRowClick(e, index)}
              onMouseDown={(e) => handleRowMouseDown(e, index)}
              onDoubleClick={() => { setSelectedTrackIds(new Set()); onPlayTracks([playlistTrackToMinimalTrack(t)], 0, selectedPlaylist ? playlistContext(selectedPlaylist) : null); }}
              onContextMenu={(e) => {
                e.preventDefault();
                const specs: MenuItemSpec[] = [
                  { kind: "item", text: "Play", action: () => onPlayTracks([playlistTrackToMinimalTrack(t)], 0, selectedPlaylist ? playlistContext(selectedPlaylist) : null) },
                  { kind: "item", text: "Enqueue", action: () => onEnqueueTracks([playlistTrackToMinimalTrack(t)]) },
                ];
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
                      specs.push({ kind: "item", text: item.label, action: () => onPluginAction?.(item.pluginId, item.id, { kind: "track", title: t.title, artistName: t.artist_name ?? undefined }) });
                    });
                  }
                }
                showNativeMenu(e.clientX, e.clientY, specs);
              }}
              subtitle={<>{t.artist_name ?? "Unknown"}{t.album_name ? <> {"·"} {t.album_name}</> : null}</>}
              meta={formatDuration(t.duration_secs)}
              actions={{
                onPlay: () => onPlayTracks([playlistTrackToMinimalTrack(t)], 0, selectedPlaylist ? playlistContext(selectedPlaylist) : null),
                onEnqueue: () => onEnqueueTracks([playlistTrackToMinimalTrack(t)]),
                onStartRadio: onStartRadio ? () => onStartRadio({ title: t.title, artistName: t.artist_name, coverPath: trackImagePath(t) }) : undefined,
                onDetails: onLocateTrack ? () => onLocateTrack(t.title, t.artist_name, t.album_name) : undefined,
              }}
            />
          ))}
        </div>
        {folderErrorModal}
        {deleteModal}
      </div>
    );
  }

  // List view
  const protectedSystem = filtered.filter(isProtectedSystem);
  const autoPlaylists = filtered.filter(isAuto);
  const regularPlaylists = filtered.filter((p) => !p.system_kind);

  return (
    <>
      <ViewSearchBar
        query={searchQuery}
        onQueryChange={onSearchChange}
        placeholder="Search playlists..."
      />
      <div className="playlists-view">
      {filtered.length === 0 ? (
        <div className="playlists-empty ds-empty">{searchQuery.trim()
          ? "No matching playlists"
          : "No saved playlists yet — play some tracks, then use Save → Save as Playlist in the queue panel."}</div>
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
                      : <IconThumbsDownFilled size={26} />}
                  </div>
                  <div className="playlist-shortcut-name">{pl.name}</div>
                  <button className="playlist-shortcut-play" onClick={(e) => handlePlayPlaylist(e, pl)} title="Play">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg>
                  </button>
                </div>
              ))}
            </div>
          )}
          {autoPlaylists.length > 0 && (
            <div className="playlists-section">
              <div className="playlists-section-header">
                <h3 className="playlists-section-title">Made for you</h3>
                <button
                  className="ds-btn ds-btn--ghost ds-btn--sm"
                  onClick={handleRefreshAuto}
                  disabled={refreshingAuto}
                  title="Regenerate your mixes"
                >
                  {refreshingAuto ? <span className="ds-spinner ds-spinner--sm" /> : <IconRefresh size={15} />}
                  Refresh
                </button>
              </div>
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
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg>
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
                        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg>
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
