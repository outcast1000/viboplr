import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Track, Album, ColumnConfig } from "../types";

import { getProvidersForContext } from "../searchProviders";
import { ALBUM_DETAIL_COLUMNS } from "../hooks/useLibrary";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { useDetailActions, useDetailState } from "../contexts/DetailViewContext";
import { ImageActions } from "./ImageActions";
import { LikeDislikeButtons } from "./LikeDislikeButtons";
import { TrackList } from "./TrackList";
import { InformationSections } from "./InformationSections";
import { TitleLineInfo } from "./TitleLineInfo";
import type { InfoEntity } from "../types/informationTypes";
import { store } from "../store";

interface AlbumDetailProps {
  name: string;
  artistName?: string;
}

export function AlbumDetail({ name, artistName }: AlbumDetailProps) {
  const actions = useDetailActions();
  const state = useDetailState();
  const {
    entity,
    sortedTracks,
    isLibrary,
    sortField,
    handleSort,
    sortIndicator,
    trackPopularity,
    handleToggleLike: handleToggleAlbumLike,
    handleToggleDislike: handleToggleAlbumDislike,
  } = useEntityDetail({ kind: "album", name, artistName, invokeInfoFetch: actions.invokeInfoFetch, onEntityLike: actions.toggleEntityLike, onEntityDislike: actions.toggleEntityDislike });

  const album = entity as Album | null;

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

  const albumProviders = getProvidersForContext(actions.searchProviders, "album");
  const displayArtist = album?.artist_name ?? artistName;
  const albumImagePath = actions.getAlbumImage(name, artistName ?? null);

  const infoEntity: InfoEntity = album
    ? { kind: "album", name: album.title, id: album.id, artistName: album.artist_name ?? undefined }
    : { kind: "album", name, id: 0, artistName };

  const handleEntityClick = useCallback((kind: string, id?: number, entityName?: string) => {
    if (kind === "artist") actions.navigateToArtist(id ?? 0, entityName);
    else if (kind === "album") actions.navigateToAlbum(id ?? 0, undefined, entityName);
  }, [actions.navigateToArtist, actions.navigateToAlbum]);

  const handleInfoAction = useCallback((actionId: string, payload?: unknown) => {
    if (actionId === "play-track") {
      const t = payload as Track | undefined;
      if (t) actions.playTracks([t], 0);
    }
  }, [actions.playTracks]);

  const resolveEntity = useCallback((kind: string, entityName: string) => {
    if (kind === "artist") {
      const imgPath = actions.getArtistImage(entityName);
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
  }, [sortedTracks, actions.getArtistImage, displayArtist]);

  const handlePlayAll = useCallback(() => {
    actions.playEntityAll("album", name, artistName, {
      tracks: sortedTracks.filter(t => t.liked !== -1),
      entityId: album?.id,
    });
  }, [actions.playEntityAll, name, artistName, sortedTracks, album]);

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
                onClick={handlePlayAll}
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
              onImageChanged={() => actions.invalidateImage("album", name, artistName)}
              onRefresh={() => actions.requestFetchImage("album", name, artistName)}
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
                onClick={() => actions.navigateToArtist(album?.artist_id ?? 0, displayArtist ?? undefined)}
              >{displayArtist}</span>
            )}
            {isLibrary && (
              <span className="artist-meta">
                {album?.year && <>{album.year} {"·"} </>}
                {album?.track_count ?? 0} tracks
              </span>
            )}
            <span className="artist-bio-stats">
              <TitleLineInfo entity={infoEntity} invokeInfoFetch={actions.invokeInfoFetch} />
            </span>
          </div>
        </div>
      </div>

      {isLibrary && sortedTracks.length > 0 && (
        <TrackList
          tracks={sortedTracks}
          currentTrack={state.currentTrack}
          playing={state.playing}
          highlightedIndex={-1}
          sortField={sortField}
          trackListRef={trackListRef}
          columns={trackColumns}
          onColumnsChange={setTrackColumns}
          onDoubleClick={actions.playTracks}
          onContextMenu={actions.handleTrackContextMenu}
          onArtistClick={actions.navigateToArtist}
          onAlbumClick={actions.navigateToAlbum}
          onSort={handleSort}
          sortIndicator={sortIndicator}
          onToggleLike={actions.toggleLike}
          onToggleDislike={actions.toggleDislike}
          onTrackDragStart={actions.handleTrackDragStart}
          onDeleteTracks={actions.deleteTracks}
          trackPopularity={trackPopularity}
          emptyMessage="No tracks found."
        />
      )}

      <div className="section-wide">
        <InformationSections
          entity={infoEntity}
          exclude={[]}
          placement="below"
          invokeInfoFetch={actions.invokeInfoFetch}
          pluginNames={actions.pluginNames}
          tabOrder={belowTabOrder}
          onTabOrderChange={handleBelowTabOrderChange}
          onEntityClick={handleEntityClick}
          onAction={handleInfoAction}
          resolveEntity={resolveEntity}
          onTrackContextMenu={actions.handleInfoTrackContextMenu}
          onEntityContextMenu={actions.handleEntityContextMenu}
        />
      </div>
    </div>
  );
}
