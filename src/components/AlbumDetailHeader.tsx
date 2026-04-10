import { useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Album, Track } from "../types";
import type { SearchProviderConfig } from "../searchProviders";
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";
import { getProvidersForContext } from "../searchProviders";
import { AlbumOptionsMenu } from "./AlbumOptionsMenu";
import { InformationSections } from "./InformationSections";

interface AlbumDetailHeaderProps {
  selectedAlbum: number;
  album: Album | undefined;
  albumImagePath: string | null;
  sortedTracks: Track[];
  searchProviders: SearchProviderConfig[];
  onArtistClick: (artistId: number) => void;
  onToggleAlbumLike: (albumId: number) => void;
  onToggleAlbumHate: (albumId: number) => void;
  onPlayTracks: (tracks: Track[], index: number) => void;
  onImageSet: (id: number, path: string) => void;
  onImageRemoved: (id: number) => void;
  onRetrieveImage: () => void;
  invokeInfoFetch: (pluginId: string, infoTypeId: string, entity: InfoEntity, onFetchUrl?: (url: string) => void) => Promise<InfoFetchResult>;
  pluginNames?: Map<string, string>;
}

export function AlbumDetailHeader({
  selectedAlbum,
  album,
  albumImagePath,
  sortedTracks,
  searchProviders,
  onArtistClick,
  onToggleAlbumLike,
  onToggleAlbumHate,
  onPlayTracks,
  onImageSet,
  onImageRemoved,
  onRetrieveImage,
  invokeInfoFetch,
  pluginNames,
}: AlbumDetailHeaderProps) {
  const albumProviders = getProvidersForContext(searchProviders, "album");

  const handleInfoAction = useCallback((actionId: string, payload?: unknown) => {
    if (actionId === "play-track") {
      const t = payload as Track | undefined;
      if (t) onPlayTracks([t], 0);
    }
  }, [onPlayTracks]);

  const albumEntity: InfoEntity | null = album ? {
    kind: "album",
    name: album.title,
    id: album.id,
    artistName: album.artist_name ?? undefined,
  } : null;

  return (
    <>
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
            <AlbumOptionsMenu
              albumId={selectedAlbum}
              albumImagePath={albumImagePath}
              albumTitle={album?.title ?? ""}
              artistName={album?.artist_name ?? ""}
              providers={albumProviders}
              onImageSet={onImageSet}
              onImageRemoved={onImageRemoved}
              onRetrieveImage={onRetrieveImage}
            />
          </div>
          <div className="album-detail-info">
            <h2>
              {album?.title ?? "Unknown"}
              <button
                className={`detail-love-btn${album?.liked === 1 ? " liked" : ""}`}
                onClick={() => onToggleAlbumLike(selectedAlbum)}
                title={album?.liked === 1 ? "Unlike album" : "Love album"}
              >
                {album?.liked === 1
                  ? <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                  : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>}
              </button>
              <button
                className={`detail-hate-btn${album?.liked === -1 ? " hated" : ""}`}
                onClick={() => onToggleAlbumHate(selectedAlbum)}
                title={album?.liked === -1 ? "Remove hate" : "Hate album"}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>
              </button>
              {sortedTracks.length > 0 && (
                <button
                  className="artist-play-btn"
                  title="Play All"
                  onClick={() => onPlayTracks(sortedTracks.filter(t => t.liked !== -1), 0)}
                >&#9654;</button>
              )}
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
        <InformationSections
          placement="right"
          entity={albumEntity}
          exclude={[]}
          invokeInfoFetch={invokeInfoFetch}
          pluginNames={pluginNames}
          onAction={handleInfoAction}
        />
      </div>
      <div className="section-wide">
        <InformationSections
          placement="below"
          entity={albumEntity}
          exclude={[]}
          invokeInfoFetch={invokeInfoFetch}
          pluginNames={pluginNames}
          onAction={handleInfoAction}
        />
      </div>
    </>
  );
}
