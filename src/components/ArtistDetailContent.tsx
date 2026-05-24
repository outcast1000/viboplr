import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getInitials } from "../utils";
import type { Track, Artist, ColumnConfig } from "../types";

import { ARTIST_DETAIL_COLUMNS } from "../hooks/useLibrary";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { useDetailActions, useDetailState } from "../contexts/DetailViewContext";
import { AlbumCardArt } from "./AlbumCardArt";
import { ImageActions } from "./ImageActions";
import { LikeDislikeButtons } from "./LikeDislikeButtons";
import { TrackList } from "./TrackList";
import { InformationSections } from "./InformationSections";
import { TitleLineInfo } from "./TitleLineInfo";
import { DetailHeroBackground } from "./DetailHeroBackground";
import type { InfoEntity } from "../types/informationTypes";
import { store } from "../store";
import { useDetailHeroImages } from "../hooks/useDetailHeroImages";

interface ArtistDetailContentProps {
  name: string;
}

export function ArtistDetailContent({ name }: ArtistDetailContentProps) {
  const actions = useDetailActions();
  const state = useDetailState();
  const {
    entity,
    sortedTracks,
    albums,
    isLibrary,
    sortField,
    handleSort,
    sortIndicator,
    trackPopularity,
    handleToggleLike: handleToggleArtistLike,
    handleToggleDislike: handleToggleArtistDislike,
  } = useEntityDetail({ kind: "artist", name, invokeInfoFetch: actions.invokeInfoFetch, onEntityLike: actions.toggleEntityLike, onEntityDislike: actions.toggleEntityDislike });

  const artist = entity as Artist | null;

  const [trackColumns, setTrackColumns] = useState<ColumnConfig[]>(ARTIST_DETAIL_COLUMNS);
  const trackListRef = useRef<HTMLDivElement>(null);
  const [headerTabOrder, setHeaderTabOrder] = useState<string[]>([]);
  const [belowTabOrder, setBelowTabOrder] = useState<string[]>([]);

  useEffect(() => {
    store.get<string[]>("artistDetailHeaderTabOrder").then(saved => {
      if (saved && saved.length > 0) setHeaderTabOrder(saved);
    });
    store.get<string[]>("artistDetailBelowTabOrder").then(saved => {
      if (saved && saved.length > 0) setBelowTabOrder(saved);
    });
  }, []);

  const handleHeaderTabOrderChange = useCallback((order: string[]) => {
    setHeaderTabOrder(order);
    store.set("artistDetailHeaderTabOrder", order);
  }, []);

  const handleBelowTabOrderChange = useCallback((order: string[]) => {
    setBelowTabOrder(order);
    store.set("artistDetailBelowTabOrder", order);
  }, []);

  const resolveEntity = useCallback((kind: string, entityName: string) => {
    if (kind === "artist") {
      const imgPath = actions.getArtistImage(entityName);
      if (artist && artist.name.toLowerCase() === entityName.toLowerCase()) {
        return { id: artist.id, imageSrc: imgPath ? convertFileSrc(imgPath) : undefined };
      }
      return imgPath ? { imageSrc: convertFileSrc(imgPath) } : undefined;
    }
    if (kind === "track") {
      const [trackName, trackArtistName] = entityName.includes("|||") ? entityName.split("|||") : [entityName, artist?.name];
      const match = sortedTracks.find(t =>
        t.title.toLowerCase() === trackName.toLowerCase() &&
        (!trackArtistName || (t.artist_name ?? "").toLowerCase() === trackArtistName.toLowerCase())
      );
      if (match) return { id: match.id ?? undefined };
    }
    return undefined;
  }, [artist, sortedTracks, actions.getArtistImage]);

  const handleInfoAction = useCallback((actionId: string, payload?: unknown) => {
    if (actionId === "play-track") {
      const t = payload as Track | undefined;
      if (t) actions.playTracks([t], 0);
    }
  }, [actions.playTracks]);

  const infoEntity: InfoEntity = artist
    ? { kind: "artist", name: artist.name, id: artist.id }
    : { kind: "artist", name, id: 0 };

  const handleEntityClick = useCallback((kind: string, id?: number, entityName?: string) => {
    if (kind === "artist") actions.navigateToArtist(id ?? 0, entityName);
    else if (kind === "album") actions.navigateToAlbum(id ?? 0, undefined, entityName);
  }, [actions.navigateToArtist, actions.navigateToAlbum]);

  const artistImagePath = actions.getArtistImage(name);

  const requestAlbumImage = useCallback(
    (title: string, artistName: string) => actions.requestFetchImage("album", title, artistName),
    [actions.requestFetchImage],
  );
  const heroImages = useDetailHeroImages.artistAlbums(
    artist,
    albums,
    actions.getAlbumImage,
    requestAlbumImage,
  );

  const handlePlayAll = useCallback(() => {
    actions.playEntityAll("artist", name, undefined, {
      tracks: sortedTracks.filter(t => t.liked !== -1),
      entityId: artist?.id,
    });
  }, [actions.playEntityAll, name, sortedTracks, artist]);

  return (
    <div className="artist-detail">
      <div className="artist-detail-top">
        <DetailHeroBackground images={heroImages} className="artist-detail-bg" />
        <div className="artist-header">
          <div className="artist-avatar">
            {artistImagePath ? (
              <img className="artist-avatar-img" src={convertFileSrc(artistImagePath)} alt={name} />
            ) : (
              getInitials(name)
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
              entityType="artist"
              entityName={name}
              imagePath={artistImagePath}
              providers={actions.searchProviders}
              onImageChanged={() => actions.invalidateImage("artist", name)}
              onRefresh={() => actions.requestFetchImage("artist", name)}
            />
          </div>
          <div className="artist-header-info">
            <h2>
              {name}
              {isLibrary && (
                <LikeDislikeButtons
                  liked={artist?.liked ?? 0}
                  onToggleLike={handleToggleArtistLike}
                  onToggleDislike={handleToggleArtistDislike}
                  size={16}
                  variant="glass"
                  entityLabel="artist"
                />
              )}
            </h2>
            {isLibrary && <span className="artist-meta">{artist?.track_count ?? 0} tracks</span>}
            <span className="artist-bio-stats">
              <TitleLineInfo entity={infoEntity} invokeInfoFetch={actions.invokeInfoFetch} />
            </span>
          </div>
        </div>
      </div>
      <div className="section-wide">
        <InformationSections
          entity={infoEntity}
          exclude={["artist_stats"]}
          placement="header"
          customTabs={albums.length > 0 ? [{
            id: "albums",
            name: "Albums",
            content: (
              <div className="album-scroll">
                {albums.map((a) => (
                  <div key={a.id} className="album-card" onClick={() => actions.navigateToAlbum(a.id)} onContextMenu={(e) => actions.handleAlbumContextMenu(e, a.id)}>
                    <div className="album-card-art-wrapper">
                      <AlbumCardArt album={a} imagePath={actions.getAlbumImage(a.title, a.artist_name)} />
                      <button className="album-card-play-btn" title="Play album" onClick={(e) => {
                        e.stopPropagation();
                        actions.playAlbum(a.id);
                      }}><svg viewBox="0 0 24 24" width="25" height="25" fill="white" style={{marginLeft: 2}}><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg></button>
                    </div>
                    <div className="album-card-body">
                      <div className="album-card-title" title={a.title}>{a.title}</div>
                      <div className="album-card-info">
                        {a.year ? String(a.year) : ""}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ),
          }] : undefined}
          invokeInfoFetch={actions.invokeInfoFetch}
          pluginNames={actions.pluginNames}
          tabOrder={headerTabOrder}
          onTabOrderChange={handleHeaderTabOrderChange}
          onEntityClick={handleEntityClick}
          onAction={handleInfoAction}
          resolveEntity={resolveEntity}
          onTrackContextMenu={actions.handleInfoTrackContextMenu}
          onEntityContextMenu={actions.handleEntityContextMenu}
        />
      </div>

      {sortedTracks.length > 0 && (
        <div className="artist-section">
          <div className="section-title">All Tracks</div>
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
            emptyMessage="No tracks found for this artist."
          />
        </div>
      )}

      <div className="section-wide">
        <InformationSections
          entity={infoEntity}
          exclude={["artist_stats"]}
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
