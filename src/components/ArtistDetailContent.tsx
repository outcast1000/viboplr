import { useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getInitials, formatCount } from "../utils";
import type { Artist, Album, Track, ColumnConfig, SortField } from "../types";
import type { SearchProviderConfig } from "../searchProviders";
import { ARTIST_DETAIL_COLUMNS } from "../hooks/useLibrary";
import { AlbumCardArt } from "./AlbumCardArt";
import { ImageActions } from "./ImageActions";
import { TrackList } from "./TrackList";

interface ArtistDetailContentProps {
  selectedArtist: number;
  artist: Artist | undefined;
  artistImagePath: string | null;
  artistBio: { summary: string; listeners: string; playcount: string } | null;
  artistInfoLoading: boolean;
  similarArtists: Array<{ name: string; match: string }>;
  artistTopTracks: Array<{ name: string; listeners: number; libraryTrack?: Track }>;
  artistTrackPopularity: Record<number, number>;
  sections: Record<string, boolean>;
  onToggleSection: (key: string) => void;
  sortedTracks: Track[];
  artistAlbums: Album[];
  artistImages: Record<number, string | null>;
  albumImages: Record<number, string | null>;
  onFetchAlbumImage: (album: Album) => void;
  onSetArtistImage: (images: Record<number, string | null>) => void;
  onForceFetchArtistImage: (entity: { id: number; name: string }) => void;
  currentTrack: Track | null;
  playing: boolean;
  highlightedIndex: number;
  sortField: SortField | null;
  trackListRef: React.RefObject<HTMLDivElement | null>;
  onPlayTracks: (tracks: Track[], index: number) => void;
  onTrackContextMenu: (e: React.MouseEvent, track: Track, selectedTrackIds: Set<number>) => void;
  onArtistClick: (id: number) => void;
  onAlbumClick: (id: number) => void;
  onSort: (field: SortField) => void;
  sortIndicator: (field: SortField) => string;
  onToggleLike: (track: Track) => void;
  onToggleDislike: (track: Track) => void;
  onTrackDragStart: (tracks: Track[]) => void;
  onDeleteTracks?: (trackIds: number[]) => void;
  onToggleArtistLike: (artistId: number) => void;
  onRefreshInfo: () => void;
  onTopSongContextMenu: (e: React.MouseEvent, entry: { name: string; listeners: number; libraryTrack?: Track }, artistName: string) => void;
  onAlbumContextMenu: (e: React.MouseEvent, albumId: number) => void;
  searchProviders: SearchProviderConfig[];
  addLog: (message: string) => void;
  artists: Artist[];
}

export function ArtistDetailContent({
  selectedArtist,
  artist,
  artistImagePath,
  artistBio,
  artistInfoLoading,
  similarArtists,
  artistTopTracks,
  artistTrackPopularity,
  sections,
  onToggleSection,
  sortedTracks,
  artistAlbums,
  artistImages,
  albumImages,
  onFetchAlbumImage,
  onSetArtistImage,
  onForceFetchArtistImage,
  currentTrack,
  playing,
  highlightedIndex,
  sortField,
  trackListRef,
  onPlayTracks,
  onTrackContextMenu,
  onArtistClick,
  onAlbumClick,
  onSort,
  sortIndicator,
  onToggleLike,
  onToggleDislike,
  onTrackDragStart,
  onDeleteTracks,
  onToggleArtistLike,
  onRefreshInfo,
  onTopSongContextMenu,
  onAlbumContextMenu,
  searchProviders,
  addLog,
  artists,
}: ArtistDetailContentProps) {
  const [trackColumns, setTrackColumns] = useState<ColumnConfig[]>(ARTIST_DETAIL_COLUMNS);

  return (
    <div className="artist-detail">
      <div className="artist-detail-top">
        <div className="artist-header">
          <div className="artist-avatar">
            {artistImagePath ? (
              <img className="artist-avatar-img" src={convertFileSrc(artistImagePath)} alt={artist?.name} />
            ) : (
              artist ? getInitials(artist.name) : "?"
            )}
          </div>
          <div className="artist-header-info">
            <h2>
              {artist?.name ?? "Unknown"}
              <span
                className={`detail-like-btn${artist?.liked === 1 ? " liked" : ""}`}
                onClick={() => onToggleArtistLike(selectedArtist)}
                title={artist?.liked === 1 ? "Unlike artist" : "Like artist"}
              >{artist?.liked === 1 ? "\u2665" : "\u2661"}</span>
              {sortedTracks.length > 0 && (
                <button
                  className="artist-play-btn"
                  title="Play All"
                  onClick={() => onPlayTracks(sortedTracks.filter(t => t.liked !== -1), 0)}
                >&#9654;</button>
              )}
              <ImageActions
                entityId={selectedArtist}
                entityType="artist"
                entityName={artist?.name}
                imagePath={artistImagePath}
                providers={searchProviders}
                onImageSet={(id, path) => onSetArtistImage({ ...artistImages, [id]: path })}
                onImageRemoved={(id) => {
                  onSetArtistImage({ ...artistImages, [id]: null });
                }}
                onRefresh={() => {
                  if (!artist) return;
                  onForceFetchArtistImage({ id: selectedArtist, name: artist.name });
                  onRefreshInfo();
                }}
              />
            </h2>
            <span className="artist-meta">{artist?.track_count ?? 0} tracks</span>
            {artistInfoLoading && !artistBio && (
              <span className="artist-bio-stats lastfm-loading">Fetching info from Last.fm…</span>
            )}
            {artistBio && (artistBio.listeners || artistBio.playcount) && (
              <span className="artist-bio-stats">
                {artistBio.listeners && <>{parseInt(artistBio.listeners).toLocaleString()} listeners</>}
                {artistBio.listeners && artistBio.playcount && " \u00B7 "}
                {artistBio.playcount && <>{parseInt(artistBio.playcount).toLocaleString()} scrobbles</>}
              </span>
            )}
          </div>
        </div>
        {artistTopTracks.length > 0 && (
          <div className="section-narrow">
            <div className="artist-bio-title section-header" onClick={() => onToggleSection("topSongs")}>
              <svg className={`section-chevron${sections.topSongs === false ? " collapsed" : ""}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              Top Songs
            </div>
            {sections.topSongs !== false && (() => {
              const maxPop = artistTopTracks[0]?.listeners ?? 1;
              return (
                <div className="top-songs-list">
                  {artistTopTracks.map((entry, i) => {
                    const pct = maxPop > 0 ? (entry.listeners / maxPop) * 100 : 0;
                    const inLibrary = !!entry.libraryTrack;
                    const handleAction = async () => {
                      if (inLibrary) {
                        onPlayTracks([entry.libraryTrack!], 0);
                      } else {
                        addLog("Searching YouTube...");
                        try {
                          const result = await invoke<{ url: string; video_title: string | null }>(
                            "search_youtube", { title: entry.name, artistName: artist?.name ?? "" }
                          );
                          await openUrl(result.url);
                        } catch {
                          const q = encodeURIComponent(`${entry.name} ${artist?.name ?? ""}`);
                          await openUrl(`https://www.youtube.com/results?search_query=${q}`);
                        }
                      }
                    };
                    return (
                      <div
                        key={`${entry.name}-${i}`}
                        className={`top-song-row${inLibrary ? "" : " top-song-missing"}`}
                        onDoubleClick={handleAction}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          onTopSongContextMenu(e, entry, artist?.name ?? "");
                        }}
                      >
                        <span className="top-song-rank">{i + 1}</span>
                        <button
                          className="top-song-action-btn"
                          title={inLibrary ? "Play" : "Watch on YouTube"}
                          onClick={handleAction}
                        >
                          {inLibrary ? "\u25B6" : <svg width="14" height="10" viewBox="0 0 28 20" fill="currentColor"><path d="M27.4 3.1s-.3-1.9-1.1-2.8C25.1-.9 23.7-.9 23-.9 19.2-1.2 14-1.2 14-1.2h0s-5.2 0-9 .3c-.7.1-2.1.1-3.3 1.1C.9 1.2.6 3.1.6 3.1S.3 5.3.3 7.6v2.1c0 2.2.3 4.5.3 4.5s.3 1.9 1.1 2.8c1.2 1.2 2.7 1.2 3.4 1.3 2.4.2 10.3.3 10.3.3s5.2 0 9-.3c.7-.1 2.1-.1 3.3-1.1.8-.9 1.1-2.8 1.1-2.8s.3-2.2.3-4.5V7.6c0-2.2-.3-4.5-.3-4.5zM11.1 13.2V5.4l8.9 3.9-8.9 3.9z"/></svg>}
                        </button>
                        <span className="col-popularity top-song-pop">
                          <span className="popularity-fill" style={{ width: `${pct}%` }} />
                          <span className="popularity-count">{formatCount(entry.listeners)}</span>
                        </span>
                        <span className="top-song-title">{entry.name}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        )}
        <div className="section-wide">
          <div className="artist-bio-title section-header" onClick={() => onToggleSection("about")}>
            <svg className={`section-chevron${sections.about === false ? " collapsed" : ""}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            About
          </div>
          {sections.about !== false && (
            <>
              {artistInfoLoading && !artistBio && (
                <div className="lastfm-loading-text">Loading…</div>
              )}
              {artistBio && (
                <div className="artist-bio-text" dangerouslySetInnerHTML={{ __html: artistBio.summary }} />
              )}
              {!artistInfoLoading && !artistBio && (
                <div className="lastfm-empty-text">No artist info available on Last.fm</div>
              )}
            </>
          )}
        </div>
      </div>

      {artistAlbums.length > 0 && (
        <div className="artist-section artist-albums-section">
          <div className="section-title section-header" onClick={() => onToggleSection("albums")}>
            <svg className={`section-chevron${sections.albums === false ? " collapsed" : ""}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            Albums
          </div>
          {sections.albums !== false && (
            <div className="album-scroll">
              {artistAlbums.map((a) => (
                <div key={a.id} className="album-card" onClick={() => onAlbumClick(a.id)} onContextMenu={(e) => onAlbumContextMenu(e, a.id)}>
                  <div className="album-card-art-wrapper">
                    <AlbumCardArt album={a} imagePath={albumImages[a.id]} onVisible={onFetchAlbumImage} />
                    <button className="album-card-play-btn" title="Play album" onClick={async (e) => {
                      e.stopPropagation();
                      const albumTracks = await invoke<Track[]>("get_tracks", { opts: { albumId: a.id } });
                      if (albumTracks.length > 0) onPlayTracks(albumTracks, 0);
                    }}>&#9654;</button>
                  </div>
                  <div className="album-card-body">
                    <div className="album-card-title" title={a.title}>{a.title}</div>
                    <div className="album-card-info">
                      {a.year ? `${a.year} \u00B7 ` : ""}{a.track_count} tracks
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="artist-section">
        <div className="section-title">All Tracks</div>
        <TrackList
          tracks={sortedTracks}
          currentTrack={currentTrack}
          playing={playing}
          highlightedIndex={highlightedIndex}
          sortField={sortField}
          trackListRef={trackListRef}
          columns={trackColumns}
          onColumnsChange={setTrackColumns}
          onDoubleClick={onPlayTracks}
          onContextMenu={onTrackContextMenu}
          onArtistClick={onArtistClick}
          onAlbumClick={onAlbumClick}
          onSort={onSort}
          sortIndicator={sortIndicator}
          onToggleLike={onToggleLike}
          onToggleDislike={onToggleDislike}
          onTrackDragStart={onTrackDragStart}
          onDeleteTracks={onDeleteTracks}
          trackPopularity={artistTrackPopularity}
          emptyMessage="No tracks found for this artist."
        />
      </div>

      {similarArtists.length > 0 && (
        <div className="artist-section">
          <div className="section-title section-header" onClick={() => onToggleSection("similarArtists")}>
            <svg className={`section-chevron${sections.similarArtists === false ? " collapsed" : ""}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            Similar Artists
          </div>
          {sections.similarArtists !== false && (
            <div className="similar-artists-row">
              {similarArtists.slice(0, 8).map(sa => {
                const localArtist = artists.find(a => a.name.toLowerCase() === sa.name.toLowerCase());
                return (
                  <div
                    key={sa.name}
                    className={`similar-artist-card${localArtist ? " clickable" : ""}`}
                    onClick={() => localArtist && onArtistClick(localArtist.id)}
                  >
                    <div className="similar-artist-avatar">
                      {localArtist && artistImages[localArtist.id] ? (
                        <img src={convertFileSrc(artistImages[localArtist.id]!)} alt={sa.name} />
                      ) : (
                        sa.name[0]?.toUpperCase() ?? "?"
                      )}
                    </div>
                    <span className="similar-artist-name" title={sa.name}>{sa.name}</span>
                    <span className="similar-artist-match">{Math.round(parseFloat(sa.match) * 100)}%</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
