import { convertFileSrc } from "@tauri-apps/api/core";
import type { Album, Track } from "../types";

import type { SearchProviderConfig } from "../searchProviders";
import { getProvidersForContext } from "../searchProviders";
import { ImageActions } from "./ImageActions";
import { LikeDislikeButtons } from "./LikeDislikeButtons";

interface AlbumDetailHeaderProps {
  selectedAlbum: number;
  album: Album | undefined;
  albumImagePath: string | null;
  sortedTracks: Track[];
  searchProviders: SearchProviderConfig[];
  onArtistClick: (artistId: number) => void;
  onToggleAlbumLike: (albumId: number) => void;
  onToggleAlbumDislike: (albumId: number) => void;
  onPlayTracks: (tracks: Track[], index: number) => void;
  onImageSet: (id: number, path: string) => void;
  onImageRemoved: (id: number) => void;
  onRetrieveImage: () => void;
}

export function AlbumDetailHeader({
  selectedAlbum,
  album,
  albumImagePath,
  sortedTracks,
  searchProviders,
  onArtistClick,
  onToggleAlbumLike,
  onToggleAlbumDislike,
  onPlayTracks,
  onImageSet,
  onImageRemoved,
  onRetrieveImage,
}: AlbumDetailHeaderProps) {
  const albumProviders = getProvidersForContext(searchProviders, "album");

  return (
    <div
        className="album-detail-top"
        style={albumImagePath ? { '--artist-bg': `url(${convertFileSrc(albumImagePath)})` } as React.CSSProperties : undefined}
      >
        <div className="album-detail-header">
          <div className="album-detail-art">
            {albumImagePath ? (
              <img className="album-detail-art-img" src={convertFileSrc(albumImagePath)} alt={album?.title} />
            ) : (
              <svg className="album-detail-art-placeholder" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
            {sortedTracks.length > 0 && (
              <button
                className="detail-art-play"
                title="Play All"
                onClick={() => onPlayTracks(sortedTracks.filter(t => t.liked !== -1), 0)}
              >
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg>
              </button>
            )}
            <ImageActions
              entityId={selectedAlbum}
              entityType="album"
              entityName={album?.title}
              artistName={album?.artist_name ?? undefined}
              imagePath={albumImagePath}
              providers={albumProviders}
              onImageSet={onImageSet}
              onImageRemoved={onImageRemoved}
              onRefresh={onRetrieveImage}
            />
          </div>
          <div className="album-detail-info">
            <h2>
              {album?.title ?? "Unknown"}
              <LikeDislikeButtons
                liked={album?.liked ?? 0}
                onToggleLike={() => onToggleAlbumLike(selectedAlbum)}
                onToggleDislike={() => onToggleAlbumDislike(selectedAlbum)}
                entityLabel="album"
              />
            </h2>
            {album?.artist_name && (
              <span
                className="album-detail-artist-name"
                onClick={() => { if (album.artist_id) onArtistClick(album.artist_id); }}
              >{album.artist_name}</span>
            )}
            <span className="artist-meta">
              {album?.year && <>{album.year} {"\u00B7"} </>}
              {album?.track_count ?? 0} tracks
            </span>
          </div>
        </div>
      </div>
  );
}
