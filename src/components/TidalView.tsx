import { useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  Track,
  TidalSearchResult,
  TidalSearchTrack,
  TidalSearchAlbum,
  TidalSearchArtist,
  TidalAlbumDetail,
  TidalArtistDetail,
} from "../types";
import { formatDuration, tidalCoverUrl } from "../utils";
import { ViewSearchBar } from "./ViewSearchBar";
import "./TidalView.css";

type TidalSubView =
  | { kind: "search" }
  | { kind: "album"; album: TidalAlbumDetail }
  | { kind: "artist"; artist: TidalArtistDetail };

interface TidalViewProps {
  collectionId: number;
  onPlayTracks: (tracks: Track[], startIndex: number) => void;
  onEnqueueTracks: (tracks: Track[]) => void;
}

export function TidalView({ collectionId, onPlayTracks, onEnqueueTracks }: TidalViewProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TidalSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [subView, setSubView] = useState<TidalSubView>({ kind: "search" });
  const [savingId, setSavingId] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  async function doSearch(q: string) {
    if (!q.trim()) {
      setResults(null);
      return;
    }
    setLoading(true);
    try {
      const res = await invoke<TidalSearchResult>("tidal_search", {
        collectionId,
        query: q.trim(),
        limit: 25,
        offset: 0,
      });
      setResults(res);
    } catch (e) {
      console.error("TIDAL search failed:", e);
    } finally {
      setLoading(false);
    }
  }

  function handleQueryChange(value: string) {
    setQuery(value);
    setSubView({ kind: "search" });
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(value), 400);
  }

  async function handlePlayTrack(track: TidalSearchTrack) {
    setSavingId(track.tidal_id);
    try {
      const saved = await invoke<Track>("tidal_save_track", {
        collectionId,
        tidalTrackId: track.tidal_id,
      });
      onPlayTracks([saved], 0);
    } catch (e) {
      console.error("Failed to play TIDAL track:", e);
    } finally {
      setSavingId(null);
    }
  }

  async function handleEnqueueTrack(track: TidalSearchTrack) {
    try {
      const saved = await invoke<Track>("tidal_save_track", {
        collectionId,
        tidalTrackId: track.tidal_id,
      });
      onEnqueueTracks([saved]);
    } catch (e) {
      console.error("Failed to enqueue TIDAL track:", e);
    }
  }

  async function handleAlbumClick(albumId: string) {
    setLoading(true);
    try {
      const album = await invoke<TidalAlbumDetail>("tidal_get_album", {
        collectionId,
        albumId,
      });
      setSubView({ kind: "album", album });
    } catch (e) {
      console.error("Failed to load album:", e);
    } finally {
      setLoading(false);
    }
  }

  async function handleArtistClick(artistId: string) {
    setLoading(true);
    try {
      const artist = await invoke<TidalArtistDetail>("tidal_get_artist", {
        collectionId,
        artistId,
      });
      setSubView({ kind: "artist", artist });
    } catch (e) {
      console.error("Failed to load artist:", e);
    } finally {
      setLoading(false);
    }
  }

  async function handlePlayAlbum(tracks: TidalSearchTrack[]) {
    setSavingId("album");
    try {
      const saved: Track[] = [];
      for (const t of tracks) {
        const s = await invoke<Track>("tidal_save_track", {
          collectionId,
          tidalTrackId: t.tidal_id,
        });
        saved.push(s);
      }
      onPlayTracks(saved, 0);
    } catch (e) {
      console.error("Failed to play album:", e);
    } finally {
      setSavingId(null);
    }
  }

  function handleBack() {
    setSubView({ kind: "search" });
  }

  return (
    <div className="tidal-view">
      <ViewSearchBar
        query={query}
        onQueryChange={handleQueryChange}
        placeholder="Search TIDAL..."
        autoFocus
        onEnter={() => doSearch(query)}
      >
        {loading && <span className="tidal-loading">Loading...</span>}
      </ViewSearchBar>

      {subView.kind === "search" && results && (
        <div className="tiles-scroll">
          {results.tracks.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <h3>Tracks</h3>
              <TrackResults
                tracks={results.tracks}
                savingId={savingId}
                onPlay={handlePlayTrack}
                onEnqueue={handleEnqueueTrack}
                onAlbumClick={handleAlbumClick}
                onArtistClick={handleArtistClick}
              />
            </div>
          )}
          {results.albums.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <h3>Albums</h3>
              <AlbumResults albums={results.albums} onAlbumClick={handleAlbumClick} />
            </div>
          )}
          {results.artists.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <h3>Artists</h3>
              <ArtistResults artists={results.artists} onArtistClick={handleArtistClick} />
            </div>
          )}
          {results.tracks.length === 0 && results.albums.length === 0 && results.artists.length === 0 && (
            <div className="empty">No results found</div>
          )}
        </div>
      )}

      {subView.kind === "search" && !results && !loading && (
        <div className="empty">Search TIDAL's catalog above</div>
      )}

      {subView.kind === "album" && (
        <AlbumDetailView
          album={subView.album}
          savingId={savingId}
          onBack={handleBack}
          onPlayTrack={handlePlayTrack}
          onEnqueueTrack={handleEnqueueTrack}
          onPlayAlbum={handlePlayAlbum}
          onArtistClick={handleArtistClick}
        />
      )}

      {subView.kind === "artist" && (
        <ArtistDetailView
          artist={subView.artist}
          onBack={handleBack}
          onAlbumClick={handleAlbumClick}
        />
      )}
    </div>
  );
}

function TrackResults({
  tracks,
  savingId,
  onPlay,
  onEnqueue,
  onAlbumClick,
  onArtistClick,
}: {
  tracks: TidalSearchTrack[];
  savingId: string | null;
  onPlay: (t: TidalSearchTrack) => void;
  onEnqueue: (t: TidalSearchTrack) => void;
  onAlbumClick: (id: string) => void;
  onArtistClick: (id: string) => void;
}) {
  return (
    <div className="track-list">
      {tracks.map((t) => (
        <div key={t.tidal_id} className="track-row">
          <span className="col-art">
            {tidalCoverUrl(t.cover_id, 80) ? (
              <img src={tidalCoverUrl(t.cover_id, 80)!} alt="" />
            ) : (
              <span style={{ width: "100%", height: "100%", background: "var(--bg-surface)" }} />
            )}
          </span>
          <span className="col-title">{t.title}</span>
          <span className="col-artist">
            {t.artist_name && t.artist_id ? (
              <span
                className="track-link"
                onClick={(e) => { e.stopPropagation(); onArtistClick(t.artist_id!); }}
              >
                {t.artist_name}
              </span>
            ) : (t.artist_name || "")}
          </span>
          <span className="col-album">
            {t.album_title && t.album_id ? (
              <span
                className="track-link"
                onClick={(e) => { e.stopPropagation(); onAlbumClick(t.album_id!); }}
              >
                {t.album_title}
              </span>
            ) : (t.album_title || "")}
          </span>
          <span className="col-duration">{formatDuration(t.duration_secs)}</span>
          <button
            className="tidal-action-btn"
            onClick={() => onPlay(t)}
            disabled={savingId === t.tidal_id}
            title="Play"
          >
            {savingId === t.tidal_id ? "\u23F3" : "\u25B6"}
          </button>
          <button
            className="tidal-action-btn"
            onClick={() => onEnqueue(t)}
            title="Add to queue"
          >
            +
          </button>
        </div>
      ))}
    </div>
  );
}

function AlbumResults({
  albums,
  onAlbumClick,
}: {
  albums: TidalSearchAlbum[];
  onAlbumClick: (id: string) => void;
}) {
  return (
    <div className="album-grid">
      {albums.map((a) => (
        <div key={a.tidal_id} className="album-card" onClick={() => onAlbumClick(a.tidal_id)}>
          <div className="album-card-art">
            {tidalCoverUrl(a.cover_id, 320) ? (
              <img className="album-card-art-img" src={tidalCoverUrl(a.cover_id, 320)!} alt="" />
            ) : (
              a.title[0]?.toUpperCase() ?? "?"
            )}
          </div>
          <div className="album-card-body">
            <div className="album-card-title">{a.title}</div>
            <div className="album-card-info">
              {a.artist_name && a.year ? `${a.artist_name} - ${a.year}` : a.artist_name || (a.year ? String(a.year) : "")}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ArtistResults({
  artists,
  onArtistClick,
}: {
  artists: TidalSearchArtist[];
  onArtistClick: (id: string) => void;
}) {
  return (
    <div className="album-grid">
      {artists.map((a) => (
        <div key={a.tidal_id} className="artist-card" onClick={() => onArtistClick(a.tidal_id)}>
          <div className="artist-card-art">
            {tidalCoverUrl(a.picture_id, 320) ? (
              <img className="artist-card-art-img" src={tidalCoverUrl(a.picture_id, 320)!} alt="" />
            ) : (
              a.name[0]?.toUpperCase() ?? "?"
            )}
          </div>
          <div className="artist-card-body">
            <div className="artist-card-name">{a.name}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function AlbumDetailView({
  album,
  savingId,
  onBack,
  onPlayTrack,
  onEnqueueTrack,
  onPlayAlbum,
  onArtistClick,
}: {
  album: TidalAlbumDetail;
  savingId: string | null;
  onBack: () => void;
  onPlayTrack: (t: TidalSearchTrack) => void;
  onEnqueueTrack: (t: TidalSearchTrack) => void;
  onPlayAlbum: (tracks: TidalSearchTrack[]) => void;
  onArtistClick: (id: string) => void;
}) {
  return (
    <div className="tidal-detail">
      <button className="tidal-back" onClick={onBack}>{"\u2190"} Back</button>
      <div className="tidal-detail-header">
        <div className="tidal-detail-art">
          {tidalCoverUrl(album.cover_id, 640) ? (
            <img src={tidalCoverUrl(album.cover_id, 640)!} alt="" />
          ) : (
            <div className="tidal-art-placeholder tidal-art-placeholder-lg" />
          )}
        </div>
        <div className="tidal-detail-info">
          <h2>{album.title}</h2>
          {album.artist_name && <p className="tidal-detail-sub">{album.artist_name}</p>}
          {album.year && <p className="tidal-detail-sub">{album.year}</p>}
          <button
            className="tidal-btn tidal-btn-play-all"
            onClick={() => onPlayAlbum(album.tracks)}
            disabled={savingId === "album"}
          >
            {savingId === "album" ? "Loading..." : "\u25B6 Play Album"}
          </button>
        </div>
      </div>
      <div className="tidal-track-list">
        {album.tracks.map((t, i) => (
          <div key={t.tidal_id} className="tidal-track-row tidal-track-row-album">
            <span className="tidal-track-num">{t.track_number ?? i + 1}</span>
            <div className="tidal-track-info">
              <span className="tidal-track-title">{t.title}</span>
              {t.artist_name && t.artist_name !== album.artist_name && (
                <span className="tidal-track-meta">
                  <span className="tidal-link" onClick={() => { if (t.artist_id) onArtistClick(t.artist_id); }}>
                    {t.artist_name}
                  </span>
                </span>
              )}
            </div>
            <span className="tidal-track-duration">{formatDuration(t.duration_secs)}</span>
            <button
              className="tidal-btn tidal-btn-play"
              onClick={() => onPlayTrack(t)}
              disabled={savingId === t.tidal_id}
              title="Play"
            >
              {savingId === t.tidal_id ? "\u23F3" : "\u25B6"}
            </button>
            <button
              className="tidal-btn tidal-btn-enqueue"
              onClick={() => onEnqueueTrack(t)}
              title="Add to queue"
            >
              +
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ArtistDetailView({
  artist,
  onBack,
  onAlbumClick,
}: {
  artist: TidalArtistDetail;
  onBack: () => void;
  onAlbumClick: (id: string) => void;
}) {
  return (
    <div className="tidal-detail">
      <button className="tidal-back" onClick={onBack}>{"\u2190"} Back</button>
      <div className="tidal-detail-header">
        <div className="tidal-detail-art tidal-detail-art-round">
          {tidalCoverUrl(artist.picture_id, 640) ? (
            <img src={tidalCoverUrl(artist.picture_id, 640)!} alt="" />
          ) : (
            <div className="tidal-art-placeholder tidal-art-placeholder-lg" />
          )}
        </div>
        <div className="tidal-detail-info">
          <h2>{artist.name}</h2>
          <p className="tidal-detail-sub">{artist.albums.length} albums</p>
        </div>
      </div>
      <h3>Discography</h3>
      <div className="tidal-card-grid">
        {artist.albums.map((a) => (
          <div key={a.tidal_id} className="tidal-card" onClick={() => onAlbumClick(a.tidal_id)}>
            <div className="tidal-card-art">
              {tidalCoverUrl(a.cover_id, 320) ? (
                <img src={tidalCoverUrl(a.cover_id, 320)!} alt="" />
              ) : (
                <div className="tidal-art-placeholder" />
              )}
            </div>
            <div className="tidal-card-title">{a.title}</div>
            <div className="tidal-card-sub">{a.year ?? ""}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
