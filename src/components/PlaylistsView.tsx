import { useState, useEffect, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { DeletePlaylistModal } from "./DeletePlaylistModal";
import type { PluginMenuItem, PluginContextMenuTarget } from "../types/plugin";
import type { PlaylistContext } from "../hooks/useQueue";
import { showNativeMenu, type MenuItemSpec } from "../nativeMenu";
import playlistDefault from "../assets/playlist-default.png";
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
}

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatDuration(secs: number | null): string {
  if (secs == null) return "";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function playlistTrackToMinimalTrack(t: PlaylistTrack): { title: string; artist_name: string | null; album_title: string | null; duration_secs: number | null; url: string | null; path: string; image_url?: string } {
  return {
    title: t.title,
    artist_name: t.artist_name,
    album_title: t.album_name,
    duration_secs: t.duration_secs ?? null,
    url: t.source,
    path: t.source ?? "",
    image_url: t.image_path ?? undefined,
  };
}

interface PlaylistsViewProps {
  searchQuery: string;
  onPlayTracks: (tracks: any[], startIndex: number, context?: PlaylistContext | null) => void;
  onEnqueueTracks: (tracks: any[]) => void;
  onExportAsMixtape?: (trackIds: number[], defaultTitle?: string) => void;
  pluginMenuItems?: PluginMenuItem[];
  onPluginAction?: (pluginId: string, actionId: string, target: PluginContextMenuTarget) => void;
}

function isLocalPath(source: string | null): boolean {
  return !!source && source.startsWith("file://");
}

function playlistContext(pl: Playlist): PlaylistContext {
  const metadata: Record<string, string> | null = pl.metadata ? JSON.parse(pl.metadata) : null;
  return {
    name: pl.name,
    imagePath: pl.image_path,
    source: pl.source ?? "playlist",
    description: pl.description,
    metadata,
    remote: false,
  };
}

export function PlaylistsView({ searchQuery, onPlayTracks, onEnqueueTracks, onExportAsMixtape, pluginMenuItems, onPluginAction }: PlaylistsViewProps) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<PlaylistTrack[]>([]);
  const [deleteConfirm, setDeleteConfirm] = useState<Playlist | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);

  const loadPlaylists = useCallback(async () => {
    const rows = await invoke<Playlist[]>("get_playlists");
    setPlaylists(rows);
  }, []);

  useEffect(() => {
    loadPlaylists();
  }, [loadPlaylists]);

  const openPlaylist = useCallback(async (pl: Playlist) => {
    setSelectedPlaylist(pl);
    const rows = await invoke<PlaylistTrack[]>("get_playlist_tracks", { playlistId: pl.id });
    setTracks(rows);
  }, []);

  const goBack = useCallback(() => {
    setSelectedPlaylist(null);
    setTracks([]);
  }, []);

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
    const rows = await invoke<PlaylistTrack[]>("get_playlist_tracks", { playlistId: pl.id });
    if (rows.length > 0) {
      onPlayTracks(rows.map(playlistTrackToMinimalTrack), 0, playlistContext(pl));
    }
  }, [onPlayTracks]);

  const handleEnqueuePlaylist = useCallback(async (pl: Playlist) => {
    const rows = await invoke<PlaylistTrack[]>("get_playlist_tracks", { playlistId: pl.id });
    if (rows.length > 0) {
      onEnqueueTracks(rows.map(playlistTrackToMinimalTrack));
    }
  }, [onEnqueueTracks]);

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
          const paths = rows.map(t => t.source).filter((s): s is string => s != null);
          if (paths.length === 0) return;
          const libraryTracks = await invoke<{ id: number }[]>("get_tracks_by_paths", { paths });
          if (libraryTracks.length > 0) onExportAsMixtape(libraryTracks.map(t => t.id), pl.name);
        } catch (e) {
          console.error("Failed to prepare mixtape export:", e);
        }
      }});
    }
    specs.push({ kind: "separator" });
    specs.push({ kind: "item", text: "Delete", action: () => setDeleteConfirm(pl) });
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

  // Filter by search query
  const filtered = searchQuery
    ? playlists.filter((p) => p.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : playlists;

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
    return (
      <div className="playlists-view">
        <div className="playlists-detail-header">
          <img
            className="playlists-detail-cover"
            src={selectedPlaylist.image_path ? imageUrl(selectedPlaylist.image_path) : playlistDefault}
            alt=""
          />
          <div className="playlists-detail-info">
            <button className="playlists-back-btn" onClick={goBack}>&larr; Back</button>
            <h2>{selectedPlaylist.name}</h2>
            <div className="playlists-detail-meta">
              {selectedPlaylist.track_count} tracks &middot; Saved {formatDate(selectedPlaylist.saved_at)}
            </div>
            <div className="playlists-detail-actions">
              <button className="playlists-action-btn playlists-action-btn-play" onClick={() => onPlayTracks(tracks.map(playlistTrackToMinimalTrack), 0, playlistContext(selectedPlaylist))} disabled={tracks.length === 0}>Play</button>
              <button className="playlists-action-btn" onClick={() => handleExport(selectedPlaylist)}>Export as M3U</button>
              {onExportAsMixtape && (
                <button className="playlists-action-btn" onClick={async () => {
                  const paths = tracks.map(t => t.source).filter((s): s is string => s != null);
                  if (paths.length === 0) return;
                  try {
                    const libraryTracks = await invoke<{ id: number }[]>("get_tracks_by_paths", { paths });
                    if (libraryTracks.length > 0) {
                      onExportAsMixtape(libraryTracks.map(t => t.id), selectedPlaylist.name);
                    }
                  } catch (e) {
                    console.error("Failed to prepare mixtape export:", e);
                  }
                }} disabled={tracks.length === 0}>Export as Mixtape</button>
              )}
              <button className="playlists-action-btn playlists-action-btn-danger" onClick={() => setDeleteConfirm(selectedPlaylist)}>Delete</button>
            </div>
          </div>
        </div>
        <div className="playlists-tracks-table">
          <div className="playlists-tracks-header">
            <div className="playlists-col-num">#</div>
            <div className="playlists-col-title">Title</div>
            <div className="playlists-col-artist">Artist</div>
            <div className="playlists-col-album">Album</div>
            <div className="playlists-col-duration">Duration</div>
          </div>
          {tracks.map((t) => (
            <div key={t.id} className="playlists-track-row" onContextMenu={(e) => {
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
            }}>
              <div className="playlists-col-num">{t.position + 1}</div>
              <div className="playlists-col-title">
                {t.image_path && (
                  <img className="playlists-track-thumb" src={imageUrl(t.image_path)} alt="" />
                )}
                {t.title}
              </div>
              <div className="playlists-col-artist">{t.artist_name ?? ""}</div>
              <div className="playlists-col-album">{t.album_name ?? ""}</div>
              <div className="playlists-col-duration">{formatDuration(t.duration_secs)}</div>
            </div>
          ))}
        </div>
        {folderErrorModal}
        {deleteModal}
      </div>
    );
  }

  // List view
  return (
    <div className="playlists-view">
      {filtered.length === 0 ? (
        <div className="playlists-empty">No saved playlists</div>
      ) : (
        <div className="playlists-grid">
          {filtered.map((pl) => (
            <div key={pl.id} className="playlist-card" onClick={() => openPlaylist(pl)} onContextMenu={(e) => handleContextMenu(e, pl)}>
              <div className="playlist-card-art">
                <img src={pl.image_path ? imageUrl(pl.image_path) : playlistDefault} alt="" />
                <button className="playlist-card-more" onClick={(e) => handleMoreClick(e, pl)} title="More options">&#x22EF;</button>
                <button className="playlist-card-play" onClick={(e) => handlePlayPlaylist(e, pl)} title="Play">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg>
                </button>
              </div>
              <div className="playlist-card-info">
                <div className="playlist-card-name">{pl.name}</div>
              </div>
              <div className="playlist-card-meta">
                {pl.track_count} tracks &middot; {formatDate(pl.saved_at)}
              </div>
            </div>
          ))}
        </div>
      )}
      {deleteModal}
    </div>
  );
}
