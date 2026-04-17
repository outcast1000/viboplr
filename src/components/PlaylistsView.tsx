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
  onPlayTracks: (tracks: any[], startIndex: number, context?: { name: string; coverPath?: string | null; coverUrl?: string | null } | null) => void;
  onEnqueueTracks: (tracks: any[]) => void;
  pluginMenuItems?: PluginMenuItem[];
  onPluginAction?: (pluginId: string, actionId: string, target: PluginContextMenuTarget) => void;
}

export function PlaylistsView({ searchQuery, onPlayTracks, onEnqueueTracks, pluginMenuItems, onPluginAction }: PlaylistsViewProps) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<PlaylistTrack[]>([]);
  const [deleteConfirm, setDeleteConfirm] = useState<Playlist | null>(null);
  const [contextMenu, setContextMenu] = useState<{ pl: Playlist; x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

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
      onPlayTracks(rows.map(playlistTrackToMinimalTrack), 0, { name: pl.name, coverPath: pl.image_path });
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
    if (!contextMenu) return;
    const handle = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [contextMenu]);

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
              <button className="playlists-action-btn playlists-action-btn-play" onClick={() => onPlayTracks(tracks.map(playlistTrackToMinimalTrack), 0, { name: selectedPlaylist.name, coverPath: selectedPlaylist.image_path })} disabled={tracks.length === 0}>Play</button>
              <button className="playlists-action-btn" onClick={() => handleExport(selectedPlaylist)}>Export M3U</button>
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
            <div key={t.id} className="playlists-track-row">
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
                <button className="playlist-card-play" onClick={(e) => handlePlayPlaylist(e, pl)} title="Play">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </button>
              </div>
              <div className="playlist-card-info">
                <div className="playlist-card-name">{pl.name}</div>
                <button className="playlist-card-more" onClick={(e) => handleMoreClick(e, pl)} title="More options">&#x22EF;</button>
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
