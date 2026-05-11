import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Track, QueueTrack, ColumnConfig } from "../types";

import type { SearchProviderConfig } from "../searchProviders";
import { getProvidersForContext } from "../searchProviders";
import { ALBUM_DETAIL_COLUMNS } from "../hooks/useLibrary";
import { useAlbumDetail } from "../hooks/useAlbumDetail";
import { ImageActions } from "./ImageActions";
import { LikeDislikeButtons } from "./LikeDislikeButtons";
import { TrackList } from "./TrackList";
import { InformationSections } from "./InformationSections";
import { TitleLineInfo } from "./TitleLineInfo";
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";
import { store } from "../store";

interface AlbumDetailProps {
  name: string;
  artistName?: string;
  getAlbumImage: (title: string, artistName?: string | null) => string | null;
  getArtistImage: (name: string) => string | null;
  onImageChanged: () => void;
  onRefreshImage: () => void;
  searchProviders: SearchProviderConfig[];
  currentTrack: QueueTrack | null;
  playing: boolean;
  onPlayTracks: (tracks: Track[], index: number) => void;
  onArtistClick: (id: number) => void;
  onNavigateToArtistByName: (name: string) => void;
  onAlbumClick: (id: number) => void;
  onTrackContextMenu: (e: React.MouseEvent, track: Track, selectedTrackIds: Set<string>) => void;
  onToggleLike: (track: Track) => void;
  onToggleDislike: (track: Track) => void;
  onTrackDragStart: (tracks: Track[]) => void;
  onDeleteTracks?: (trackIds: number[]) => void;
  invokeInfoFetch: (pluginId: string, infoTypeId: string, entity: InfoEntity, onFetchUrl?: (url: string) => void) => Promise<InfoFetchResult>;
  pluginNames?: Map<string, string>;
  onInfoTrackContextMenu?: (e: React.MouseEvent, trackInfo: { trackId?: number; title: string; artistName: string | null }) => void;
  onEntityContextMenu?: (e: React.MouseEvent, info: { kind: "track" | "artist" | "album"; id?: number; name: string; artistName?: string | null }) => void;
}

export function AlbumDetail({
  name,
  artistName,
  getAlbumImage,
  getArtistImage,
  onImageChanged,
  onRefreshImage,
  searchProviders,
  currentTrack,
  playing,
  onPlayTracks,
  onArtistClick,
  onNavigateToArtistByName,
  onAlbumClick,
  onTrackContextMenu,
  onToggleLike,
  onToggleDislike,
  onTrackDragStart,
  onDeleteTracks,
  invokeInfoFetch,
  pluginNames,
  onInfoTrackContextMenu,
  onEntityContextMenu,
}: AlbumDetailProps) {
  const {
    album,
    sortedTracks,
    isLibrary,
    sortField,
    handleSort,
    sortIndicator,
    trackPopularity,
    handleToggleAlbumLike,
    handleToggleAlbumDislike,
  } = useAlbumDetail(name, artistName, invokeInfoFetch);

  const [trackColumns, setTrackColumns] = useState<ColumnConfig[]>(ALBUM_DETAIL_COLUMNS);
  const trackListRef = useRef<HTMLDivElement>(null);
  const [belowTabOrder, setBelowTabOrder] = useState<string[]>([]);

  useEffect(() => {
    store.get<string[]>("albumDetailBelowTabOrder").then(saved => {
      if (saved && saved.length > 0) setBelowTabOrder(saved);
    });
  }, []);

  const handleBelowTabOrderChange = useCallback((order: string[]) => {
    setBelowTabOrder(order);
    store.set("albumDetailBelowTabOrder", order);
  }, []);

  const albumProviders = getProvidersForContext(searchProviders, "album");
  const displayArtist = album?.artist_name ?? artistName;
  const albumImagePath = getAlbumImage(name, artistName ?? null);

  const entity: InfoEntity = album
    ? { kind: "album", name: album.title, id: album.id, artistName: album.artist_name ?? undefined }
    : { kind: "album", name, id: 0, artistName };

  const handleEntityClick = useCallback((kind: string, id?: number, entityName?: string) => {
    if (kind === "artist" && id) onArtistClick(id);
    else if (kind === "artist" && entityName) onNavigateToArtistByName(entityName);
    if (kind === "album" && id) onAlbumClick(id);
  }, [onArtistClick, onAlbumClick, onNavigateToArtistByName]);

  const handleInfoAction = useCallback((actionId: string, payload?: unknown) => {
    if (actionId === "play-track") {
      const t = payload as Track | undefined;
      if (t) onPlayTracks([t], 0);
    }
  }, [onPlayTracks]);

  const resolveEntity = useCallback((kind: string, entityName: string) => {
    if (kind === "artist") {
      const imgPath = getArtistImage(entityName);
      return imgPath ? { imageSrc: convertFileSrc(imgPath) } : undefined;
    }
    if (kind === "track") {
      const [trackName, trackArtistName] = entityName.includes("|||") ? entityName.split("|||") : [entityName, displayArtist];
      const match = sortedTracks.find(t =>
        t.title.toLowerCase() === trackName.toLowerCase() &&
        (!trackArtistName || (t.artist_name ?? "").toLowerCase() === trackArtistName.toLowerCase())
      );
      if (match) return { id: match.id ?? undefined };
    }
    return undefined;
  }, [sortedTracks, getArtistImage, displayArtist]);

  return (
    <div className="album-detail">
      <div
        className="album-detail-top"
        style={albumImagePath ? { '--artist-bg': `url(${convertFileSrc(albumImagePath)})` } as React.CSSProperties : undefined}
      >
        <div className="album-detail-header">
          <div className="album-detail-art">
            {albumImagePath ? (
              <img className="album-detail-art-img" src={convertFileSrc(albumImagePath)} alt={name} />
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
              entityType="album"
              entityName={name}
              artistName={displayArtist ?? undefined}
              imagePath={albumImagePath}
              providers={albumProviders}
              onImageChanged={onImageChanged}
              onRefresh={onRefreshImage}
            />
          </div>
          <div className="album-detail-info">
            <h2>
              {name}
              {isLibrary && (
                <LikeDislikeButtons
                  liked={album?.liked ?? 0}
                  onToggleLike={handleToggleAlbumLike}
                  onToggleDislike={handleToggleAlbumDislike}
                  size={20}
                  entityLabel="album"
                />
              )}
            </h2>
            {displayArtist && (
              <span
                className="album-detail-artist-name"
                onClick={() => {
                  if (album?.artist_id) onArtistClick(album.artist_id);
                  else if (displayArtist) onNavigateToArtistByName(displayArtist);
                }}
              >{displayArtist}</span>
            )}
            {isLibrary && (
              <span className="artist-meta">
                {album?.year && <>{album.year} {"·"} </>}
                {album?.track_count ?? 0} tracks
              </span>
            )}
            <span className="artist-bio-stats">
              <TitleLineInfo entity={entity} invokeInfoFetch={invokeInfoFetch} />
            </span>
          </div>
        </div>
      </div>

      {isLibrary && sortedTracks.length > 0 && (
        <TrackList
          tracks={sortedTracks}
          currentTrack={currentTrack}
          playing={playing}
          highlightedIndex={-1}
          sortField={sortField}
          trackListRef={trackListRef}
          columns={trackColumns}
          onColumnsChange={setTrackColumns}
          onDoubleClick={onPlayTracks}
          onContextMenu={onTrackContextMenu}
          onArtistClick={onArtistClick}
          onAlbumClick={onAlbumClick}
          onSort={handleSort}
          sortIndicator={sortIndicator}
          onToggleLike={onToggleLike}
          onToggleDislike={onToggleDislike}
          onTrackDragStart={onTrackDragStart}
          onDeleteTracks={onDeleteTracks}
          trackPopularity={trackPopularity}
          emptyMessage="No tracks found."
        />
      )}

      <div className="section-wide">
        <InformationSections
          entity={entity}
          exclude={[]}
          placement="below"
          invokeInfoFetch={invokeInfoFetch}
          pluginNames={pluginNames}
          tabOrder={belowTabOrder}
          onTabOrderChange={handleBelowTabOrderChange}
          onEntityClick={handleEntityClick}
          onAction={handleInfoAction}
          resolveEntity={resolveEntity}
          onTrackContextMenu={onInfoTrackContextMenu}
          onEntityContextMenu={onEntityContextMenu}
        />
      </div>
    </div>
  );
}
