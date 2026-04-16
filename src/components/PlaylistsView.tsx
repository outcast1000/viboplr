import { useState, useEffect, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { DeletePlaylistModal } from "./DeletePlaylistModal";
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

function playlistTrackToMinimalTrack(t: PlaylistTrack): { title: string; artist_name: string | null; album_title: string | null; duration_secs: number | null; url: string | null; path: string } {
  return {
    title: t.title,
    artist_name: t.artist_name,
    album_title: t.album_name,
    duration_secs: t.duration_secs ?? null,
    url: t.source,
    path: t.source ?? "",
  };
}

interface PlaylistsViewProps {
  searchQuery: string;
  onPlayTracks: (tracks: any[], startIndex: number) => void;
}

export function PlaylistsView({ searchQuery, onPlayTracks }: PlaylistsViewProps) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<PlaylistTrack[]>([]);
  const [deleteConfirm, setDeleteConfirm] = useState<Playlist | null>(null);

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
      onPlayTracks(rows.map(playlistTrackToMinimalTrack), 0);
    }
  }, [onPlayTracks]);

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
              <button className="playlists-action-btn playlists-action-btn-play" onClick={() => onPlayTracks(tracks.map(playlistTrackToMinimalTrack), 0)} disabled={tracks.length === 0}>Play</button>
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
            <div key={pl.id} className="playlist-card" onClick={() => openPlaylist(pl)}>
              <div className="playlist-card-art">
                <img src={pl.image_path ? imageUrl(pl.image_path) : playlistDefault} alt="" />
                <button className="playlist-card-play" onClick={(e) => handlePlayPlaylist(e, pl)} title="Play">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </button>
              </div>
              <div className="playlist-card-name">{pl.name}</div>
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
