import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Track, QueueTrack, ColumnConfig } from "../types";

import { TAG_DETAIL_COLUMNS } from "../hooks/useLibrary";
import { useTagDetail } from "../hooks/useTagDetail";
import { ImageActions } from "./ImageActions";
import { LikeDislikeButtons } from "./LikeDislikeButtons";
import { TrackList } from "./TrackList";
import { InformationSections } from "./InformationSections";
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";
import { store } from "../store";

interface TagDetailProps {
  name: string;
  getTagImage: (name: string) => string | null;
  onImageChanged: () => void;
  currentTrack: QueueTrack | null;
  playing: boolean;
  onPlayTracks: (tracks: Track[], index: number) => void;
  onArtistClick: (id: number) => void;
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

export function TagDetail({
  name,
  getTagImage,
  onImageChanged,
  currentTrack,
  playing,
  onPlayTracks,
  onArtistClick,
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
}: TagDetailProps) {
  const {
    tag,
    sortedTracks,
    isLibrary,
    sortField,
    handleSort,
    sortIndicator,
    handleToggleTagLike,
    handleToggleTagDislike,
  } = useTagDetail(name, invokeInfoFetch);

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

  const tagImagePath = getTagImage(name);

  const entity: InfoEntity = tag
    ? { kind: "tag", name: tag.name, id: tag.id }
    : { kind: "tag", name, id: 0 };

  const handleInfoAction = useCallback((actionId: string, payload?: unknown) => {
    if (actionId === "play-track") {
      const t = payload as Track | undefined;
      if (t) onPlayTracks([t], 0);
    }
  }, [onPlayTracks]);

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
                onClick={() => onPlayTracks(sortedTracks.filter(t => t.liked !== -1), 0)}
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
              onImageChanged={onImageChanged}
            />
          </div>
        </div>
      </div>

      {sortedTracks.length > 0 && (
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
          onAction={handleInfoAction}
          onTrackContextMenu={onInfoTrackContextMenu}
          onEntityContextMenu={onEntityContextMenu}
        />
      </div>
    </div>
  );
}
