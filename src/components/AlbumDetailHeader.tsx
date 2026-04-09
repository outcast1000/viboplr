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
  onPlayTracks: (tracks: Track[], index: number) => void;
  onImageSet: (id: number, path: string) => void;
  onImageRemoved: (id: number) => void;
  onRetrieveImage: () => void;
  onRetrieveInfo: () => void;
  invokeInfoFetch: (pluginId: string, infoTypeId: string, entity: InfoEntity) => Promise<InfoFetchResult>;
}

export function AlbumDetailHeader({
  selectedAlbum,
  album,
  albumImagePath,
  sortedTracks,
  searchProviders,
  onArtistClick,
  onToggleAlbumLike,
  onPlayTracks,
  onImageSet,
  onImageRemoved,
  onRetrieveImage,
  onRetrieveInfo,
  invokeInfoFetch,
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
        <InformationSections
          placement="right"
          entity={albumEntity}
          exclude={[]}
          invokeInfoFetch={invokeInfoFetch}
          onAction={handleInfoAction}
        />
      </div>
      <div className="section-wide">
        <InformationSections
          placement="below"
          entity={albumEntity}
          exclude={[]}
          invokeInfoFetch={invokeInfoFetch}
          onAction={handleInfoAction}
        />
      </div>
    </>
  );
}
