import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  TidalSearchResult,
  TidalSearchTrack,
  TidalSearchAlbum,
  TidalSearchArtist,
  TidalAlbumDetail,
  TidalArtistDetail,
} from "../types";
import { formatDuration, tidalCoverUrl } from "../utils";
import { TidalDownloadModal, type DownloadModalRequest } from "./TidalDownloadModal";

type TidalSubView =
  | { kind: "search" }
  | { kind: "album"; album: TidalAlbumDetail }
  | { kind: "artist"; artist: TidalArtistDetail };

type TidalTab = "tracks" | "albums" | "artists";

interface TidalViewProps {
  searchQuery: string;
  onPlayTrack: (tidalTrackId: string, trackInfo: TidalSearchTrack) => void;
  onEnqueueTrack: (tidalTrackId: string, trackInfo: TidalSearchTrack) => void;
  downloadFormat: string;
  localCollections?: { id: number; name: string; path: string }[];
}

export function TidalView({ searchQuery, onPlayTrack, onEnqueueTrack, downloadFormat, localCollections }: TidalViewProps) {
  const [results, setResults] = useState<TidalSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [subView, setSubView] = useState<TidalSubView>({ kind: "search" });
  const [selectedTracks, setSelectedTracks] = useState<Set<string>>(new Set());
  const [downloadModal, setDownloadModal] = useState<DownloadModalRequest | null>(null);
  const [activeTab, setActiveTab] = useState<TidalTab>("tracks");
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    const q = searchQuery.trim();
    if (!q) {
      setResults(null);
      return;
    }
    setSubView({ kind: "search" });
    setSelectedTracks(new Set());
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await invoke<TidalSearchResult>("tidal_search", {
          query: q,
          limit: 25,
          offset: 0,
        });
        setResults(res);
      } catch (e) {
        console.error("TIDAL search failed:", e);
      } finally {
        setLoading(false);
      }
    }, 400);
    return () => clearTimeout(debounceRef.current);
  }, [searchQuery]);

  function handlePlayTrack(track: TidalSearchTrack) {
    onPlayTrack(track.tidal_id, track);
  }

  function handleEnqueueTrack(track: TidalSearchTrack) {
    onEnqueueTrack(track.tidal_id, track);
  }

  async function handleAlbumClick(albumId: string) {
    setLoading(true);
    try {
      const album = await invoke<TidalAlbumDetail>("tidal_get_album", { albumId });
      setSubView({ kind: "album", album });
      setSelectedTracks(new Set());
    } catch (e) {
      console.error("Failed to load album:", e);
    } finally {
      setLoading(false);
    }
  }

  async function handleArtistClick(artistId: string) {
    setLoading(true);
    try {
      const artist = await invoke<TidalArtistDetail>("tidal_get_artist", { artistId });
      setSubView({ kind: "artist", artist });
    } catch (e) {
      console.error("Failed to load artist:", e);
    } finally {
      setLoading(false);
    }
  }

  function handlePlayAlbum(tracks: TidalSearchTrack[]) {
    if (tracks.length > 0) {
      onPlayTrack(tracks[0].tidal_id, tracks[0]);
      for (let i = 1; i < tracks.length; i++) {
        onEnqueueTrack(tracks[i].tidal_id, tracks[i]);
      }
    }
  }

  function handleBack() {
    setSubView({ kind: "search" });
    setSelectedTracks(new Set());
  }

  const toggleTrackSelection = useCallback((id: string) => {
    setSelectedTracks(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAllTracks = useCallback((tracks: TidalSearchTrack[]) => {
    setSelectedTracks(new Set(tracks.map(t => t.tidal_id)));
  }, []);

  const selectNoneTracks = useCallback(() => {
    setSelectedTracks(new Set());
  }, []);

  // Bulk actions on selected tracks
  function handlePlaySelected(tracks: TidalSearchTrack[]) {
    const selected = tracks.filter(t => selectedTracks.has(t.tidal_id));
    if (selected.length > 0) {
      onPlayTrack(selected[0].tidal_id, selected[0]);
      for (let i = 1; i < selected.length; i++) {
        onEnqueueTrack(selected[i].tidal_id, selected[i]);
      }
    }
  }

  function handleQueueSelected(tracks: TidalSearchTrack[]) {
    const selected = tracks.filter(t => selectedTracks.has(t.tidal_id));
    for (const t of selected) {
      onEnqueueTrack(t.tidal_id, t);
    }
  }

  const canDownload = localCollections && localCollections.length > 0;

  function handleDownloadTrack(track: TidalSearchTrack) {
    if (!canDownload) return;
    setDownloadModal({
      kind: "track",
      tidalTrackId: track.tidal_id,
      title: track.title,
      artistName: track.artist_name ?? "",
      coverId: track.cover_id,
      durationSecs: track.duration_secs,
    });
  }

  function handleDownloadAlbum(album: TidalAlbumDetail) {
    if (!canDownload) return;
    setDownloadModal({
      kind: "album",
      albumId: album.tidal_id,
      title: album.title,
      artistName: album.artist_name ?? "",
      coverId: album.cover_id,
      trackCount: album.tracks.length,
    });
  }

  function handleDownloadSelected(tracks: TidalSearchTrack[]) {
    if (!canDownload) return;
    const selected = tracks.filter(t => selectedTracks.has(t.tidal_id));
    if (selected.length === 0) return;
    if (selected.length === 1) {
      handleDownloadTrack(selected[0]);
      return;
    }
    setDownloadModal({ kind: "tracks", tracks: selected });
  }

  const tabs: { key: TidalTab; label: string; count: number }[] = [
    { key: "tracks", label: "Tracks", count: results?.tracks.length ?? 0 },
    { key: "albums", label: "Albums", count: results?.albums.length ?? 0 },
    { key: "artists", label: "Artists", count: results?.artists.length ?? 0 },
  ];

  return (
    <div className="tidal-view">
      {loading && <div className="tidal-loading-bar" />}

      {downloadModal && canDownload && (
        <TidalDownloadModal
          request={downloadModal}
          downloadFormat={downloadFormat}
          localCollections={localCollections}
          onClose={() => setDownloadModal(null)}
        />
      )}

      {subView.kind === "search" && results && (
        <>
          {results.tracks.length === 0 && results.albums.length === 0 && results.artists.length === 0 ? (
            <div className="tidal-empty">No results found</div>
          ) : (
            <>
              <div className="tidal-tabs">
                {tabs.map(tab => (
                  <button
                    key={tab.key}
                    className={`tidal-tab${activeTab === tab.key ? " active" : ""}`}
                    onClick={() => setActiveTab(tab.key)}
                  >
                    {tab.label}
                    {tab.count > 0 && <span className="tidal-tab-count">{tab.count}</span>}
                  </button>
                ))}
              </div>
              <div className="tidal-tab-content">
                {activeTab === "tracks" && results.tracks.length > 0 && (
                  <>
                    <TrackSelectionToolbar
                      tracks={results.tracks}
                      selectedTracks={selectedTracks}
                      onSelectAll={() => selectAllTracks(results.tracks)}
                      onSelectNone={selectNoneTracks}
                      onPlaySelected={() => handlePlaySelected(results.tracks)}
                      onQueueSelected={() => handleQueueSelected(results.tracks)}
                      onDownloadSelected={canDownload ? () => handleDownloadSelected(results.tracks) : undefined}
                    />
                    <TrackResults
                      tracks={results.tracks}
                      selectedTracks={selectedTracks}
                      onToggleSelect={toggleTrackSelection}
                      onPlay={handlePlayTrack}
                      onEnqueue={handleEnqueueTrack}
                      onAlbumClick={handleAlbumClick}
                      onArtistClick={handleArtistClick}
                      onDownloadTrack={canDownload ? handleDownloadTrack : undefined}
                    />
                  </>
                )}
                {activeTab === "tracks" && results.tracks.length === 0 && (
                  <div className="tidal-empty">No tracks found</div>
                )}

                {activeTab === "albums" && results.albums.length > 0 && (
                  <AlbumResults albums={results.albums} onAlbumClick={handleAlbumClick} />
                )}
                {activeTab === "albums" && results.albums.length === 0 && (
                  <div className="tidal-empty">No albums found</div>
                )}

                {activeTab === "artists" && results.artists.length > 0 && (
                  <ArtistResults artists={results.artists} onArtistClick={handleArtistClick} />
                )}
                {activeTab === "artists" && results.artists.length === 0 && (
                  <div className="tidal-empty">No artists found</div>
                )}
              </div>
            </>
          )}
        </>
      )}

      {subView.kind === "search" && !results && !loading && (
        <div className="tidal-empty">
          <div className="tidal-empty-content">
            <svg className="tidal-empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 16l5-5 5 5-5 5z"/><path d="M7 11l5-5 5 5-5 5z"/><path d="M12 16l5-5 5 5-5 5z"/><path d="M12 6l5-5 5 5-5 5z"/>
            </svg>
            <span>Search TIDAL to get started</span>
          </div>
        </div>
      )}

      {subView.kind === "album" && (
        <AlbumDetailView
          album={subView.album}
          selectedTracks={selectedTracks}
          onToggleSelect={toggleTrackSelection}
          onSelectAll={() => selectAllTracks(subView.album.tracks)}
          onSelectNone={selectNoneTracks}
          onBack={handleBack}
          onPlayTrack={handlePlayTrack}
          onEnqueueTrack={handleEnqueueTrack}
          onPlayAlbum={handlePlayAlbum}
          onPlaySelected={() => handlePlaySelected(subView.album.tracks)}
          onQueueSelected={() => handleQueueSelected(subView.album.tracks)}
          onArtistClick={handleArtistClick}
          onDownloadAlbum={canDownload ? handleDownloadAlbum : undefined}
          onDownloadTrack={canDownload ? handleDownloadTrack : undefined}
          onDownloadSelected={canDownload ? () => handleDownloadSelected(subView.album.tracks) : undefined}
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

function TrackSelectionToolbar({
  tracks,
  selectedTracks,
  onSelectAll,
  onSelectNone,
  onPlaySelected,
  onQueueSelected,
  onDownloadSelected,
}: {
  tracks: TidalSearchTrack[];
  selectedTracks: Set<string>;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onPlaySelected: () => void;
  onQueueSelected: () => void;
  onDownloadSelected?: () => void;
}) {
  const count = tracks.filter(t => selectedTracks.has(t.tidal_id)).length;
  const hasSelection = count > 0;

  return (
    <div className="tidal-selection-toolbar">
      <div className="tidal-selection-buttons">
        <button className="tidal-toolbar-btn" onClick={onSelectAll}>All</button>
        <button className="tidal-toolbar-btn" onClick={onSelectNone}>None</button>
        <span className="tidal-selection-count">{count} / {tracks.length}</span>
      </div>
      <div className="tidal-selection-actions">
        <button className="tidal-toolbar-btn" onClick={onPlaySelected} disabled={!hasSelection} title="Play selected">
          {"\u25B6"} Play
        </button>
        <button className="tidal-toolbar-btn" onClick={onQueueSelected} disabled={!hasSelection} title="Queue selected">
          + Queue
        </button>
        {onDownloadSelected && (
          <button
            className="tidal-toolbar-btn"
            onClick={onDownloadSelected}
            disabled={!hasSelection}
            title="Download selected"
          >
            {"\u2B07"} Download
          </button>
        )}
      </div>
    </div>
  );
}

function TrackResults({
  tracks,
  selectedTracks,
  onToggleSelect,
  onPlay,
  onEnqueue,
  onAlbumClick,
  onArtistClick,
  onDownloadTrack,
}: {
  tracks: TidalSearchTrack[];
  selectedTracks: Set<string>;
  onToggleSelect: (id: string) => void;
  onPlay: (t: TidalSearchTrack) => void;
  onEnqueue: (t: TidalSearchTrack) => void;
  onAlbumClick: (id: string) => void;
  onArtistClick: (id: string) => void;
  onDownloadTrack?: (t: TidalSearchTrack) => void;
}) {
  return (
    <div className="tidal-track-list">
      {tracks.map((t) => (
        <div key={t.tidal_id} className={`tidal-track-row ${selectedTracks.has(t.tidal_id) ? "tidal-track-selected" : ""}`}>
          <input
            type="checkbox"
            className="tidal-track-checkbox"
            checked={selectedTracks.has(t.tidal_id)}
            onChange={() => onToggleSelect(t.tidal_id)}
          />
          <div className="tidal-track-art">
            {tidalCoverUrl(t.cover_id, 80) ? (
              <img src={tidalCoverUrl(t.cover_id, 80)!} alt="" />
            ) : (
              <div className="tidal-art-placeholder" />
            )}
          </div>
          <div className="tidal-track-info">
            <span className="tidal-track-title">{t.title}</span>
            <span className="tidal-track-meta">
              {t.artist_name && (
                <span
                  className="tidal-link"
                  onClick={(e) => { e.stopPropagation(); if (t.artist_id) onArtistClick(t.artist_id); }}
                >
                  {t.artist_name}
                </span>
              )}
              {t.album_title && (
                <>
                  {" \u2014 "}
                  <span
                    className="tidal-link"
                    onClick={(e) => { e.stopPropagation(); if (t.album_id) onAlbumClick(t.album_id); }}
                  >
                    {t.album_title}
                  </span>
                </>
              )}
            </span>
          </div>
          <span className="tidal-track-duration">{formatDuration(t.duration_secs)}</span>
          <div className="tidal-track-actions">
            <button className="tidal-btn tidal-btn-play" onClick={() => onPlay(t)} title="Play">
              {"\u25B6"}
            </button>
            <button className="tidal-btn tidal-btn-enqueue" onClick={() => onEnqueue(t)} title="Add to queue">
              +
            </button>
            {onDownloadTrack && (
              <button className="tidal-btn tidal-btn-download" onClick={() => onDownloadTrack(t)} title="Download">
                {"\u2B07"}
              </button>
            )}
          </div>
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
    <div className="tidal-card-grid">
      {albums.map((a) => (
        <div key={a.tidal_id} className="tidal-card" onClick={() => onAlbumClick(a.tidal_id)}>
          <div className="tidal-card-art">
            {tidalCoverUrl(a.cover_id, 320) ? (
              <img src={tidalCoverUrl(a.cover_id, 320)!} alt="" />
            ) : (
              <div className="tidal-art-placeholder" />
            )}
          </div>
          <div className="tidal-card-title">{a.title}</div>
          <div className="tidal-card-sub">{a.artist_name}{a.year ? ` \u2022 ${a.year}` : ""}</div>
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
    <div className="tidal-card-grid">
      {artists.map((a) => (
        <div key={a.tidal_id} className="tidal-card tidal-card-artist" onClick={() => onArtistClick(a.tidal_id)}>
          <div className="tidal-card-art tidal-card-art-round">
            {tidalCoverUrl(a.picture_id, 320) ? (
              <img src={tidalCoverUrl(a.picture_id, 320)!} alt="" />
            ) : (
              <div className="tidal-art-placeholder" />
            )}
          </div>
          <div className="tidal-card-title">{a.name}</div>
        </div>
      ))}
    </div>
  );
}

function AlbumDetailView({
  album,
  selectedTracks,
  onToggleSelect,
  onSelectAll,
  onSelectNone,
  onBack,
  onPlayTrack,
  onEnqueueTrack,
  onPlayAlbum,
  onPlaySelected,
  onQueueSelected,
  onArtistClick,
  onDownloadAlbum,
  onDownloadTrack,
  onDownloadSelected,
}: {
  album: TidalAlbumDetail;
  selectedTracks: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onBack: () => void;
  onPlayTrack: (t: TidalSearchTrack) => void;
  onEnqueueTrack: (t: TidalSearchTrack) => void;
  onPlayAlbum: (tracks: TidalSearchTrack[]) => void;
  onPlaySelected: () => void;
  onQueueSelected: () => void;
  onArtistClick: (id: string) => void;
  onDownloadAlbum?: (album: TidalAlbumDetail) => void;
  onDownloadTrack?: (t: TidalSearchTrack) => void;
  onDownloadSelected?: () => void;
}) {
  const count = album.tracks.filter(t => selectedTracks.has(t.tidal_id)).length;
  const hasSelection = count > 0;

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
          {album.artist_name && (
            <p className="tidal-detail-sub tidal-link" onClick={() => {
              const artistId = album.tracks[0]?.artist_id;
              if (artistId) onArtistClick(artistId);
            }}>
              {album.artist_name}
            </p>
          )}
          {album.year && <p className="tidal-detail-sub">{album.year}</p>}
          <div className="tidal-detail-actions">
            <button
              className="tidal-btn tidal-btn-play-all"
              onClick={() => hasSelection ? onPlaySelected() : onPlayAlbum(album.tracks)}
            >
              {"\u25B6"} {hasSelection ? `Play ${count} tracks` : "Play Album"}
            </button>
            {hasSelection && (
              <button className="tidal-btn tidal-btn-play-all" onClick={onQueueSelected}>
                + Queue {count} tracks
              </button>
            )}
            {onDownloadAlbum && !hasSelection && (
              <button className="tidal-btn tidal-btn-play-all" onClick={() => onDownloadAlbum(album)}>
                {"\u2B07"} Download Album
              </button>
            )}
            {hasSelection && onDownloadSelected && (
              <button className="tidal-btn tidal-btn-play-all" onClick={onDownloadSelected}>
                {"\u2B07"} Download {count} tracks
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="tidal-selection-toolbar tidal-selection-toolbar-compact">
        <div className="tidal-selection-buttons">
          <button className="tidal-toolbar-btn" onClick={onSelectAll}>All</button>
          <button className="tidal-toolbar-btn" onClick={onSelectNone}>None</button>
          <span className="tidal-selection-count">{count} / {album.tracks.length}</span>
        </div>
      </div>

      <div className="tidal-track-list">
        {album.tracks.map((t, i) => (
          <div key={t.tidal_id} className={`tidal-track-row tidal-track-row-album ${selectedTracks.has(t.tidal_id) ? "tidal-track-selected" : ""}`}>
            <input
              type="checkbox"
              className="tidal-track-checkbox"
              checked={selectedTracks.has(t.tidal_id)}
              onChange={() => onToggleSelect(t.tidal_id)}
            />
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
            <div className="tidal-track-actions">
              <button className="tidal-btn tidal-btn-play" onClick={() => onPlayTrack(t)} title="Play">
                {"\u25B6"}
              </button>
              <button className="tidal-btn tidal-btn-enqueue" onClick={() => onEnqueueTrack(t)} title="Add to queue">
                +
              </button>
              {onDownloadTrack && (
                <button className="tidal-btn tidal-btn-download" onClick={() => onDownloadTrack(t)} title="Download">
                  {"\u2B07"}
                </button>
              )}
            </div>
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
