import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getInitials } from "../utils";
import type { Artist, ColumnConfig, QueueTrack } from "../types";

import { buildSearchUrl } from "../searchProviders";
import { ARTIST_DETAIL_COLUMNS } from "../hooks/useLibrary";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { useDetailActions, useDetailState } from "../contexts/DetailViewContext";
import { AlbumCardArt } from "./AlbumCardArt";
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
      const t = payload as QueueTrack | undefined;
      if (t) actions.playExternal([t]);
    } else if (actionId === "enqueue-track") {
      const t = payload as QueueTrack | undefined;
      if (t) actions.enqueueExternal([t]);
    }
  }, [actions.playExternal, actions.enqueueExternal]);

  const infoEntity: InfoEntity = artist
    ? { kind: "artist", name: artist.name, id: artist.id }
    : { kind: "artist", name, id: 0 };

  const handleEntityClick = useCallback((kind: string, id?: number, entityName?: string) => {
    if (kind === "artist") actions.navigateToArtist(id ?? 0, entityName);
    else if (kind === "album") actions.navigateToAlbum(id ?? 0, undefined, entityName);
  }, [actions.navigateToArtist, actions.navigateToAlbum]);

  const artistImagePath = actions.getArtistImage(name);

  const requestAlbumImage = useCallback(
    (title: string, artistName: string) => actions.autoFetchImage("album", title, artistName),
    [actions.autoFetchImage],
  );
  const albumHeroImages = useDetailHeroImages.artistAlbums(
    artist,
    albums,
    actions.getAlbumImage,
    requestAlbumImage,
  );
  // Fallback tiers when the artist has no albums to build the hero from:
  //   1. albums exist            -> album covers (above)
  //   2. else video frame grabs  -> first cached capture of each video track
  //   3. else the artist's image
  const noAlbums = albums.length === 0;
  const videoFrameImages = useDetailHeroImages.videoFrames(sortedTracks, noAlbums);
  const artistImageUrl = resolveImageUrl(artistImagePath);
  const heroImages = !noAlbums
    ? albumHeroImages
    : videoFrameImages.length > 0
      ? videoFrameImages
      : artistImageUrl
        ? [artistImageUrl]
        : [];

  const handlePlayAll = useCallback(() => {
    actions.playEntityAll("artist", name, undefined, {
      tracks: sortedTracks.filter(t => t.liked !== -1),
      entityId: artist?.id,
    });
  }, [actions.playEntityAll, name, sortedTracks, artist]);

  const handleRefreshImage = useCallback(() => {
    actions.requestFetchImage("artist", name);
  }, [actions.requestFetchImage, name]);

  const handleSetImageFromFile = useCallback(async () => {
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png"] }],
    });
    if (!selected || typeof selected !== "string") return;
    try {
      await invoke("set_entity_image", { kind: "artist", name, artistName: null, sourcePath: selected });
      actions.invalidateImage("artist", name);
    } catch (e) { console.error("Failed to set artist image:", e); }
  }, [actions.invalidateImage, name]);

  const handlePasteImage = useCallback(async () => {
    try {
      await invoke("paste_entity_image_from_clipboard", { kind: "artist", name, artistName: null });
      actions.invalidateImage("artist", name);
    } catch (e) { console.error("Failed to paste artist image:", e); }
  }, [actions.invalidateImage, name]);

  const handleRemoveImage = useCallback(async () => {
    try {
      await invoke("remove_entity_image", { kind: "artist", name, artistName: null });
      actions.invalidateImage("artist", name);
    } catch (e) { console.error("Failed to remove artist image:", e); }
  }, [actions.invalidateImage, name]);

  const handleSearchImageGoogle = useCallback(() => {
    openUrl(`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(name)}`)
      .catch(e => console.error("Failed to open image search:", e));
  }, [name]);

  const overflowItems: HeroOverflowItem[] = buildHeroOverflowItems({
    entityKind: "artist",
    imageActions: {
      onRefresh: handleRefreshImage,
      onSetFromFile: handleSetImageFromFile,
      onPasteFromClipboard: handlePasteImage,
      onRemove: artistImagePath ? handleRemoveImage : undefined,
      onSearchImage: handleSearchImageGoogle,
      webSearches: actions.searchProviders
        .filter(p => p.artistUrl)
        .map(p => ({
          id: p.id,
          label: p.name,
          onClick: () => {
            const url = buildSearchUrl(p.artistUrl!, { artist: name });
            if (url) openUrl(url).catch(e => console.error("Failed to open search URL:", e));
          },
        })),
    },
    pluginItems: [],
  });

  const handleEnqueueAll = useCallback(() => {
    actions.enqueueTracks(sortedTracks.filter(t => t.liked !== -1));
  }, [actions.enqueueTracks, sortedTracks]);

  const meta: Array<string | { label: string; onClick: () => void }> = [];
  if (isLibrary && artist?.track_count) meta.push(`${artist.track_count} tracks`);
  if (albums.length > 0) meta.push(`${albums.length} albums`);

  return (
    <div className="artist-detail">
      <DetailHero
        bgImages={heroImages}
        bgClassName="detail-hero-bg"
        art={
          artistImagePath
            ? <img src={convertFileSrc(artistImagePath)} alt={name} />
            : <span style={{ fontSize: "var(--fs-xl)", fontWeight: 700, color: "var(--accent)" }}>{getInitials(name)}</span>
        }
        artShape="circle"
        eyebrow="Artist"
        title={name}
        liked={isLibrary ? artist?.liked ?? 0 : undefined}
        onToggleLike={isLibrary ? handleToggleArtistLike : undefined}
        onToggleDislike={isLibrary ? handleToggleArtistDislike : undefined}
        entityLabel="artist"
        meta={meta}
        onPlay={sortedTracks.length > 0 ? handlePlayAll : undefined}
        onEnqueue={sortedTracks.length > 0 ? handleEnqueueAll : undefined}
        overflowItems={overflowItems}
        titleLine={<TitleLineInfo entity={infoEntity} invokeInfoFetch={actions.invokeInfoFetch} />}
      />
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
          retrieve={actions.retrieve}
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
            emptyMessage="No tracks found for this artist."
          />
        </div>
      )}

      {sortedTracks.length > 0 && (
        <EntityTagPanel tracks={sortedTracks} />
      )}

      <div className="section-wide">
        <InformationSections
          entity={infoEntity}
          exclude={["artist_stats"]}
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
