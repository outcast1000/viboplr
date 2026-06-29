import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type { Tag, ColumnConfig, QueueTrack } from "../types";

import { TAG_DETAIL_COLUMNS } from "../hooks/useLibrary";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { useDetailActions, useDetailState } from "../contexts/DetailViewContext";
import { TrackList } from "./TrackList";
import { InformationSections } from "./InformationSections";
import type { InfoEntity } from "../types/informationTypes";
import { store } from "../store";
import { useDetailHeroImages } from "../hooks/useDetailHeroImages";
import { DetailHero } from "./DetailHero";
import { buildHeroOverflowItems, type HeroOverflowItem } from "../utils/heroOverflow";
import { TitleLineInfo } from "./TitleLineInfo";
import { resolveImageUrl } from "../utils/resolveImageUrl";

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
  } = useEntityDetail({ kind: "tag", name, invokeInfoFetch: actions.invokeInfoFetch, onEntityLike: actions.toggleEntityLike, onEntityDislike: actions.toggleEntityDislike });

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

  const requestArtistImage = useCallback(
    (n: string) => actions.autoFetchImage("artist", n),
    [actions.autoFetchImage],
  );
  const heroImages = useDetailHeroImages.tagTopArtists(
    tag?.id ?? null,
    actions.getArtistImage,
    requestArtistImage,
  );

  const infoEntity: InfoEntity = tag
    ? { kind: "tag", name: tag.name, id: tag.id }
    : { kind: "tag", name, id: 0 };

  const handleSetImageFromFile = useCallback(async () => {
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png"] }],
    });
    if (!selected || typeof selected !== "string") return;
    try {
      await invoke("set_entity_image", { kind: "tag", name, artistName: null, sourcePath: selected });
      actions.invalidateImage("tag", name);
    } catch (e) { console.error("Failed to set tag image:", e); }
  }, [actions.invalidateImage, name]);

  const handlePasteImage = useCallback(async () => {
    try {
      await invoke("paste_entity_image_from_clipboard", { kind: "tag", name, artistName: null });
      actions.invalidateImage("tag", name);
    } catch (e) { console.error("Failed to paste tag image:", e); }
  }, [actions.invalidateImage, name]);

  const handleRemoveImage = useCallback(async () => {
    try {
      await invoke("remove_entity_image", { kind: "tag", name, artistName: null });
      actions.invalidateImage("tag", name);
    } catch (e) { console.error("Failed to remove tag image:", e); }
  }, [actions.invalidateImage, name]);

  const overflowItems: HeroOverflowItem[] = buildHeroOverflowItems({
    entityKind: "tag",
    imageActions: {
      onSetFromFile: handleSetImageFromFile,
      onPasteFromClipboard: handlePasteImage,
      onRemove: tagImagePath ? handleRemoveImage : undefined,
    },
    pluginItems: [],
  });

  const artistCount = new Set(sortedTracks.map(t => t.artist_name).filter(Boolean)).size;

  const handlePlayAll = useCallback(() => {
    actions.playEntityAll("tag", name, undefined, {
      tracks: sortedTracks.filter(t => t.liked !== -1),
      entityId: tag?.id,
    });
  }, [actions.playEntityAll, name, sortedTracks, tag]);

  const handleEnqueueAll = useCallback(() => {
    actions.enqueueTracks(sortedTracks.filter(t => t.liked !== -1));
  }, [actions.enqueueTracks, sortedTracks]);

  const meta: string[] = [];
  if (isLibrary && tag?.track_count) meta.push(`${tag.track_count} tracks`);
  if (artistCount > 0) meta.push(`${artistCount} artists`);

  const handleInfoAction = useCallback((actionId: string, payload?: unknown) => {
    if (actionId === "play-track") {
      const t = payload as QueueTrack | undefined;
      if (t) actions.playExternal([t]);
    } else if (actionId === "enqueue-track") {
      const t = payload as QueueTrack | undefined;
      if (t) actions.enqueueExternal([t]);
    }
  }, [actions.playExternal, actions.enqueueExternal]);

  return (
    <div className="album-detail">
      <DetailHero
        bgImages={heroImages}
        bgClassName="detail-hero-bg"
        onBack={actions.canGoBack ? actions.goBack : undefined}
        art={
          tagImagePath
            ? <img src={resolveImageUrl(tagImagePath)} alt={name} />
            : <span style={{ fontSize: "var(--fs-2xl)", fontWeight: 700 }}>{name[0]?.toUpperCase() ?? "#"}</span>
        }
        artShape="square"
        eyebrow="Tag"
        title={name}
        liked={isLibrary ? tag?.liked ?? 0 : undefined}
        onToggleLike={isLibrary ? handleToggleTagLike : undefined}
        onToggleDislike={isLibrary ? handleToggleTagDislike : undefined}
        entityLabel="tag"
        meta={meta}
        onPlay={sortedTracks.length > 0 ? handlePlayAll : undefined}
        onEnqueue={sortedTracks.length > 0 ? handleEnqueueAll : undefined}
        overflowItems={overflowItems}
        titleLine={<TitleLineInfo entity={infoEntity} invokeInfoFetch={actions.invokeInfoFetch} />}
      />

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
          onPlay={(t) => actions.playTracks([t], 0)}
          onEnqueue={(t) => actions.enqueueTracks([t])}
          onStartRadio={actions.startRadio}
          onLocateTrack={actions.locateTrack}
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
          retrieve={actions.retrieve}
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
