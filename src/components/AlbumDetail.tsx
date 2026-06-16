import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Album, ColumnConfig, QueueTrack } from "../types";

import { getProvidersForContext, buildSearchUrl } from "../searchProviders";
import { ALBUM_DETAIL_COLUMNS } from "../hooks/useLibrary";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { useDetailActions, useDetailState } from "../contexts/DetailViewContext";
import { TrackList } from "./TrackList";
import { InformationSections } from "./InformationSections";
import { TitleLineInfo } from "./TitleLineInfo";
import { DetailHero } from "./DetailHero";
import { EntityTagPanel } from "./EntityTagPanel";
import { buildHeroOverflowItems, type HeroOverflowItem } from "../utils/heroOverflow";
import type { InfoEntity } from "../types/informationTypes";
import { store } from "../store";
import { useDetailHeroImages } from "../hooks/useDetailHeroImages";
import { resolveImageUrl } from "../utils/resolveImageUrl";

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

  const heroArtistName = album?.artist_name ?? artistName ?? null;
  const requestArtistImage = useCallback(
    (n: string) => actions.autoFetchImage("artist", n),
    [actions.autoFetchImage],
  );
  const artistHeroImages = useDetailHeroImages.singleArtist(
    heroArtistName,
    actions.getArtistImage,
    requestArtistImage,
  );
  // Hero background fallback chain: artist image -> album image.
  const albumHeroUrl = resolveImageUrl(albumImagePath);
  const heroImages = artistHeroImages.length > 0
    ? artistHeroImages
    : albumHeroUrl ? [albumHeroUrl] : [];

  const infoEntity: InfoEntity = album
    ? { kind: "album", name: album.title, id: album.id, artistName: album.artist_name ?? undefined }
    : { kind: "album", name, id: 0, artistName };

  const handleEntityClick = useCallback((kind: string, id?: number, entityName?: string) => {
    if (kind === "artist") actions.navigateToArtist(id ?? 0, entityName);
    else if (kind === "album") actions.navigateToAlbum(id ?? 0, undefined, entityName);
  }, [actions.navigateToArtist, actions.navigateToAlbum]);

  const handleInfoAction = useCallback((actionId: string, payload?: unknown) => {
    if (actionId === "play-track") {
      const t = payload as QueueTrack | undefined;
      if (t) actions.playExternal([t]);
    } else if (actionId === "enqueue-track") {
      const t = payload as QueueTrack | undefined;
      if (t) actions.enqueueExternal([t]);
    }
  }, [actions.playExternal, actions.enqueueExternal]);

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

  const handleRefreshImage = useCallback(() => {
    actions.requestFetchImage("album", name, artistName);
  }, [actions.requestFetchImage, name, artistName]);

  const handleSetImageFromFile = useCallback(async () => {
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png"] }],
    });
    if (!selected || typeof selected !== "string") return;
    try {
      await invoke("set_entity_image", { kind: "album", name, artistName: artistName ?? null, sourcePath: selected });
      actions.invalidateImage("album", name, artistName);
    } catch (e) { console.error("Failed to set album image:", e); }
  }, [actions.invalidateImage, name, artistName]);

  const handlePasteImage = useCallback(async () => {
    try {
      await invoke("paste_entity_image_from_clipboard", { kind: "album", name, artistName: artistName ?? null });
      actions.invalidateImage("album", name, artistName);
    } catch (e) { console.error("Failed to paste album image:", e); }
  }, [actions.invalidateImage, name, artistName]);

  const handleRemoveImage = useCallback(async () => {
    try {
      await invoke("remove_entity_image", { kind: "album", name, artistName: artistName ?? null });
      actions.invalidateImage("album", name, artistName);
    } catch (e) { console.error("Failed to remove album image:", e); }
  }, [actions.invalidateImage, name, artistName]);

  const handleSearchImageGoogle = useCallback(() => {
    const q = encodeURIComponent(displayArtist ? `${displayArtist} ${name}` : name);
    openUrl(`https://www.google.com/search?tbm=isch&q=${q}`).catch(e => console.error("Failed to open image search:", e));
  }, [displayArtist, name]);

  const overflowItems: HeroOverflowItem[] = buildHeroOverflowItems({
    entityKind: "album",
    imageActions: {
      onRefresh: handleRefreshImage,
      onSetFromFile: handleSetImageFromFile,
      onPasteFromClipboard: handlePasteImage,
      onRemove: albumImagePath ? handleRemoveImage : undefined,
      onSearchImage: handleSearchImageGoogle,
      webSearches: albumProviders
        .filter(p => p.albumUrl)
        .map(p => ({
          id: p.id,
          label: p.name,
          onClick: () => {
            const url = buildSearchUrl(p.albumUrl!, { artist: displayArtist ?? "", title: name });
            if (url) openUrl(url).catch(e => console.error("Failed to open search URL:", e));
          },
        })),
    },
    pluginItems: [],
  });

  const handleEnqueueAll = useCallback(() => {
    actions.enqueueTracks(sortedTracks.filter(t => t.liked !== -1));
  }, [actions.enqueueTracks, sortedTracks]);

  const eyebrow = album?.year ? `Album · ${album.year}` : "Album";
  const meta: Array<string | { label: string; onClick: () => void }> = [];
  if (displayArtist) meta.push({ label: displayArtist, onClick: () => actions.navigateToArtist(album?.artist_id ?? 0, displayArtist ?? undefined) });
  if (isLibrary && album?.track_count) meta.push(`${album.track_count} tracks`);

  return (
    <div className="album-detail">
      <DetailHero
        bgImages={heroImages}
        bgClassName="detail-hero-bg"
        art={
          albumImagePath ? (
            <img src={convertFileSrc(albumImagePath)} alt={name} />
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 48, height: 48, opacity: 0.5 }}>
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          )
        }
        artShape="square"
        eyebrow={eyebrow}
        title={name}
        liked={isLibrary ? album?.liked ?? 0 : undefined}
        onToggleLike={isLibrary ? handleToggleAlbumLike : undefined}
        onToggleDislike={isLibrary ? handleToggleAlbumDislike : undefined}
        entityLabel="album"
        meta={meta}
        onPlay={sortedTracks.length > 0 ? handlePlayAll : undefined}
        onEnqueue={sortedTracks.length > 0 ? handleEnqueueAll : undefined}
        overflowItems={overflowItems}
        titleLine={<TitleLineInfo entity={infoEntity} invokeInfoFetch={actions.invokeInfoFetch} />}
      />

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
          onPlay={(t) => actions.playTracks([t], 0)}
          onEnqueue={(t) => actions.enqueueTracks([t])}
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

      {isLibrary && sortedTracks.length > 0 && (
        <EntityTagPanel tracks={sortedTracks} />
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
