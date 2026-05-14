import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Track, Tag, ColumnConfig } from "../types";

import { TAG_DETAIL_COLUMNS } from "../hooks/useLibrary";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { useDetailActions, useDetailState } from "../contexts/DetailViewContext";
import { ImageActions } from "./ImageActions";
import { LikeDislikeButtons } from "./LikeDislikeButtons";
import { TrackList } from "./TrackList";
import { InformationSections } from "./InformationSections";
import type { InfoEntity } from "../types/informationTypes";
import { store } from "../store";

interface TagDetailProps {
  name: string;
}

export function TagDetail({ name }: TagDetailProps) {
  const actions = useDetailActions();
  const state = useDetailState();
  const {
    entity,
    sortedTracks,
    isLibrary,
    sortField,
    handleSort,
    sortIndicator,
    handleToggleLike: handleToggleTagLike,
    handleToggleDislike: handleToggleTagDislike,
  } = useEntityDetail({ kind: "tag", name, invokeInfoFetch: actions.invokeInfoFetch });

  const tag = entity as Tag | null;

  const [trackColumns, setTrackColumns] = useState<ColumnConfig[]>(TAG_DETAIL_COLUMNS);
  const trackListRef = useRef<HTMLDivElement>(null);
  const [belowTabOrder, setBelowTabOrder] = useState<string[]>([]);

  useEffect(() => {
    store.get<string[]>("tagDetailBelowTabOrder").then(saved => {
      if (saved && saved.length > 0) setBelowTabOrder(saved);
    });
  }, []);

  const handleBelowTabOrderChange = useCallback((order: string[]) => {
    setBelowTabOrder(order);
    store.set("tagDetailBelowTabOrder", order);
  }, []);

  const tagImagePath = actions.getTagImage(name);

  const infoEntity: InfoEntity = tag
    ? { kind: "tag", name: tag.name, id: tag.id }
    : { kind: "tag", name, id: 0 };

  const handleInfoAction = useCallback((actionId: string, payload?: unknown) => {
    if (actionId === "play-track") {
      const t = payload as Track | undefined;
      if (t) actions.playTracks([t], 0);
    }
  }, [actions.playTracks]);

  return (
    <div className="album-detail">
      <div
        className="album-detail-top"
        style={tagImagePath ? { '--artist-bg': `url(${convertFileSrc(tagImagePath)})` } as React.CSSProperties : undefined}
      >
        <div className="album-detail-header">
          <div className="album-detail-art">
            {tagImagePath ? (
              <img className="album-detail-art-img" src={convertFileSrc(tagImagePath)} alt={name} />
            ) : (
              name[0]?.toUpperCase() ?? "#"
            )}
            {sortedTracks.length > 0 && (
              <button
                className="detail-art-play"
                title="Play All"
                onClick={() => actions.playTracks(sortedTracks.filter(t => t.liked !== -1), 0)}
              >
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg>
              </button>
            )}
          </div>
          <div className="album-detail-info">
            <h2>
              {name}
              {isLibrary && (
                <LikeDislikeButtons
                  liked={tag?.liked ?? 0}
                  onToggleLike={handleToggleTagLike}
                  onToggleDislike={handleToggleTagDislike}
                  entityLabel="tag"
                />
              )}
            </h2>
            {isLibrary && (
              <span className="artist-meta">{tag?.track_count ?? 0} tracks</span>
            )}
            <ImageActions
              entityType="tag"
              entityName={name}
              imagePath={tagImagePath}
              onImageChanged={() => actions.invalidateImage("tag", name)}
            />
          </div>
        </div>
      </div>

      {sortedTracks.length > 0 && (
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
          onAction={handleInfoAction}
          onTrackContextMenu={actions.handleInfoTrackContextMenu}
          onEntityContextMenu={actions.handleEntityContextMenu}
        />
      </div>
    </div>
  );
}
