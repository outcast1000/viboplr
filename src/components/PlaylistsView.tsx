import { useState, useEffect, useCallback, useRef } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { DeletePlaylistModal } from "./DeletePlaylistModal";
import type { PluginMenuItem, PluginContextMenuTarget } from "../types/plugin";
import playlistDefault from "../assets/playlist-default.png";
import "./PlaylistsView.css";

interface Playlist {
  id: number;
  name: string;
  source: string | null;
  saved_at: number;
  image_path: string | null;
  track_count: number;
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
  onPlayTracks: (tracks: any[], startIndex: number, context?: { name: string; imagePath?: string | null } | null) => void;
  onEnqueueTracks: (tracks: any[]) => void;
  onExportAsMixtape?: (trackIds: number[], defaultTitle?: string) => void;
  pluginMenuItems?: PluginMenuItem[];
  onPluginAction?: (pluginId: string, actionId: string, target: PluginContextMenuTarget) => void;
}

function isLocalPath(source: string | null): boolean {
  return !!source && !source.startsWith("subsonic://") && !source.startsWith("tidal://") && !source.startsWith("spotify-track://");
}

export function PlaylistsView({ searchQuery, onPlayTracks, onEnqueueTracks, onExportAsMixtape, pluginMenuItems, onPluginAction }: PlaylistsViewProps) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<PlaylistTrack[]>([]);
  const [deleteConfirm, setDeleteConfirm] = useState<Playlist | null>(null);
  const [contextMenu, setContextMenu] = useState<{ pl: Playlist; x: number; y: number } | null>(null);
  const [trackContextMenu, setTrackContextMenu] = useState<{ track: PlaylistTrack; x: number; y: number } | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const trackContextMenuRef = useRef<HTMLDivElement>(null);

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
      onPlayTracks(rows.map(playlistTrackToMinimalTrack), 0, { name: pl.name, imagePath: pl.image_path });
    }
  }, [onPlayTracks]);

  const handleEnqueuePlaylist = useCallback(async (pl: Playlist) => {
    const rows = await invoke<PlaylistTrack[]>("get_playlist_tracks", { playlistId: pl.id });
    if (rows.length > 0) {
      onEnqueueTracks(rows.map(playlistTrackToMinimalTrack));
    }
  }, [onEnqueueTracks]);

  const handleContextMenu = useCallback((e: React.MouseEvent, pl: Playlist) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ pl, x: e.clientX, y: e.clientY });
  }, []);

  const handleMoreClick = useCallback((e: React.MouseEvent, pl: Playlist) => {
    e.stopPropagation();
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    setContextMenu({ pl, x: rect.left, y: rect.bottom + 4 });
  }, []);

  useEffect(() => {
    if (!contextMenu && !trackContextMenu) return;
    const handle = (e: MouseEvent) => {
      if (contextMenu && contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
      if (trackContextMenu && trackContextMenuRef.current && !trackContextMenuRef.current.contains(e.target as Node)) {
        setTrackContextMenu(null);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [contextMenu, trackContextMenu]);

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
    <div className="ds-modal-overlay" onClick={() => setFolderError(null)}>
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
              <button className="playlists-action-btn playlists-action-btn-play" onClick={() => onPlayTracks(tracks.map(playlistTrackToMinimalTrack), 0, { name: selectedPlaylist.name, imagePath: selectedPlaylist.image_path })} disabled={tracks.length === 0}>Play</button>
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
            <div key={t.id} className="playlists-track-row" onContextMenu={(e) => { e.preventDefault(); setTrackContextMenu({ track: t, x: e.clientX, y: e.clientY }); }}>
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
        {trackContextMenu && (
          <div
            ref={trackContextMenuRef}
            className="context-menu"
            style={{ left: trackContextMenu.x, top: trackContextMenu.y }}
          >
            <div className="context-menu-item" onClick={() => {
              const t = trackContextMenu.track;
              onPlayTracks([playlistTrackToMinimalTrack(t)], 0, selectedPlaylist ? { name: selectedPlaylist.name, imagePath: selectedPlaylist.image_path } : null);
              setTrackContextMenu(null);
            }}>
              <span>Play</span>
            </div>
            <div className="context-menu-item" onClick={() => {
              onEnqueueTracks([playlistTrackToMinimalTrack(trackContextMenu.track)]);
              setTrackContextMenu(null);
            }}>
              <span>Enqueue</span>
            </div>
            {isLocalPath(trackContextMenu.track.source) && (
              <>
                <div className="context-menu-separator" />
                <div className="context-menu-item" onClick={async () => {
                  try {
                    await invoke("show_in_folder_path", { filePath: trackContextMenu.track.source! });
                  } catch (e) {
                    console.error("Failed to open containing folder:", e);
                    setFolderError(String(e));
                  }
                  setTrackContextMenu(null);
                }}>
                  <span>Open Containing Folder</span>
                </div>
              </>
            )}
            {pluginMenuItems && pluginMenuItems.length > 0 && (() => {
              const matching = pluginMenuItems.filter(item => item.targets.includes("track"));
              if (matching.length === 0) return null;
              const t = trackContextMenu.track;
              return (
                <>
                  <div className="context-menu-separator" />
                  {matching.map((item) => (
                    <div
                      key={`${item.pluginId}:${item.id}`}
                      className="context-menu-item"
                      onClick={() => {
                        onPluginAction?.(item.pluginId, item.id, {
                          kind: "track",
                          title: t.title,
                          artistName: t.artist_name ?? undefined,
                        });
                        setTrackContextMenu(null);
                      }}
                    >
                      <span>{item.label}</span>
                    </div>
                  ))}
                </>
              );
            })()}
          </div>
        )}
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
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div className="context-menu-item" onClick={() => { handlePlayPlaylist({ stopPropagation: () => {} } as React.MouseEvent, contextMenu.pl); setContextMenu(null); }}>
            <span>Play</span>
          </div>
          <div className="context-menu-item" onClick={() => { handleEnqueuePlaylist(contextMenu.pl); setContextMenu(null); }}>
            <span>Enqueue</span>
          </div>
          <div className="context-menu-item" onClick={() => { openPlaylist(contextMenu.pl); setContextMenu(null); }}>
            <span>View / Edit</span>
          </div>
          <div className="context-menu-separator" />
          <div className="context-menu-item" onClick={() => { handleExport(contextMenu.pl); setContextMenu(null); }}>
            <span>Export as M3U</span>
          </div>
          {onExportAsMixtape && (
            <div className="context-menu-item" onClick={async () => {
              const pl = contextMenu.pl;
              setContextMenu(null);
              try {
                const rows = await invoke<PlaylistTrack[]>("get_playlist_tracks", { playlistId: pl.id });
                const paths = rows.map(t => t.source).filter((s): s is string => s != null);
                if (paths.length === 0) return;
                const libraryTracks = await invoke<{ id: number }[]>("get_tracks_by_paths", { paths });
                if (libraryTracks.length > 0) {
                  onExportAsMixtape(libraryTracks.map(t => t.id), pl.name);
                }
              } catch (e) {
                console.error("Failed to prepare mixtape export:", e);
              }
            }}>
              <span>Export as Mixtape</span>
            </div>
          )}
          <div className="context-menu-separator" />
          <div className="context-menu-item context-menu-item-danger" onClick={() => { setDeleteConfirm(contextMenu.pl); setContextMenu(null); }}>
            <span>Delete</span>
          </div>
          {pluginMenuItems && pluginMenuItems.length > 0 && (() => {
            const matching = pluginMenuItems.filter(item => item.targets.includes("playlist"));
            if (matching.length === 0) return null;
            return (
              <>
                <div className="context-menu-separator" />
                {matching.map((item) => (
                  <div
                    key={`${item.pluginId}:${item.id}`}
                    className="context-menu-item"
                    onClick={() => {
                      onPluginAction?.(item.pluginId, item.id, {
                        kind: "playlist",
                        playlistId: contextMenu.pl.id,
                        playlistName: contextMenu.pl.name,
                      });
                      setContextMenu(null);
                    }}
                  >
                    <span>{item.label}</span>
                  </div>
                ))}
              </>
            );
          })()}
        </div>
      )}
      {deleteModal}
    </div>
  );
}
