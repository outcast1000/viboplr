import { convertFileSrc } from "@tauri-apps/api/core";
import type { Album, Track } from "../types";
import type { SearchProviderConfig } from "../searchProviders";
import { getProvidersForContext } from "../searchProviders";
import { AlbumOptionsMenu } from "./AlbumOptionsMenu";

interface AlbumDetailHeaderProps {
  selectedAlbum: number;
  album: Album | undefined;
  albumImagePath: string | null;
  albumWiki: string | null;
  albumInfoLoading: boolean;
  sections: Record<string, boolean>;
  onToggleSection: (key: string) => void;
  sortedTracks: Track[];
  searchProviders: SearchProviderConfig[];
  onArtistClick: (artistId: number) => void;
  onToggleAlbumLike: (albumId: number) => void;
  onPlayTracks: (tracks: Track[], index: number) => void;
  onImageSet: (id: number, path: string) => void;
  onImageRemoved: (id: number) => void;
  onRetrieveImage: () => void;
  onRetrieveInfo: () => void;
}

export function AlbumDetailHeader({
  selectedAlbum,
  album,
  albumImagePath,
  albumWiki,
  albumInfoLoading,
  sections,
  onToggleSection,
  sortedTracks,
  searchProviders,
  onArtistClick,
  onToggleAlbumLike,
  onPlayTracks,
  onImageSet,
  onImageRemoved,
  onRetrieveImage,
  onRetrieveInfo,
}: AlbumDetailHeaderProps) {
  const albumProviders = getProvidersForContext(searchProviders, "album");

  return (
    <div className="album-detail-top">
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
        </div>
        <div className="album-detail-info">
          <h2>
            {album?.title ?? "Unknown"}
            <span
              className={`detail-like-btn${album?.liked === 1 ? " liked" : ""}`}
              onClick={() => onToggleAlbumLike(selectedAlbum)}
              title={album?.liked === 1 ? "Unlike album" : "Like album"}
            >{album?.liked === 1 ? "\u2665" : "\u2661"}</span>
            {sortedTracks.length > 0 && (
              <button
                className="artist-play-btn"
                title="Play All"
                onClick={() => onPlayTracks(sortedTracks.filter(t => t.liked !== -1), 0)}
              >&#9654;</button>
            )}
            <AlbumOptionsMenu
              albumId={selectedAlbum}
              albumImagePath={albumImagePath}
              albumTitle={album?.title ?? ""}
              artistName={album?.artist_name ?? ""}
              providers={albumProviders}
              onImageSet={onImageSet}
              onImageRemoved={onImageRemoved}
              onRetrieveImage={onRetrieveImage}
              onRetrieveInfo={onRetrieveInfo}
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
      <div className="album-wiki-section">
        <div className="artist-bio-title section-header" onClick={() => onToggleSection("review")}>
          <svg className={`section-chevron${sections.review === false ? " collapsed" : ""}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          Review
        </div>
        {sections.review !== false && (
          <>
            {albumInfoLoading && !albumWiki && (
              <div className="lastfm-loading-text">Loading…</div>
            )}
            {albumWiki && (
              <div className="artist-bio-text" dangerouslySetInnerHTML={{ __html: albumWiki }} />
            )}
            {!albumInfoLoading && !albumWiki && (
              <div className="lastfm-empty-text">No album review available on Last.fm</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
