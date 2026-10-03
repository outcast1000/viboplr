import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { IMAGE_PICKER_FILTERS } from "../utils/imageFileFilters";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getInitials } from "../utils";
import type { Artist, ColumnConfig, QueueTrack } from "../types";

import { ARTIST_DETAIL_COLUMNS } from "../hooks/useLibrary";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { useDetailActions, useDetailState, useInfoSectionActions } from "../contexts/DetailViewContext";
import { AlbumCardArt } from "./AlbumCardArt";
import { LikeDislikeButtons } from "./LikeDislikeButtons";
import { TrackList, type MissingTrackRow } from "./TrackList";
import { DetailTrackFilter } from "./DetailTrackFilter";
import { filterDetailRows, showDetailFilter } from "../utils/detailTrackFilter";
import { InformationSections } from "./InformationSections";
import { TitleLineInfo } from "./TitleLineInfo";
import { DetailHero } from "./DetailHero";
import { EntityTagPanel } from "./EntityTagPanel";
import { buildHeroOverflowItems, type HeroOverflowItem } from "../utils/heroOverflow";
import type { InfoEntity } from "../types/informationTypes";
import { store } from "../store";
import { useDetailHeroImages } from "../hooks/useDetailHeroImages";
import { resolveImageUrl } from "../utils/resolveImageUrl";
import { isVariousArtists } from "../utils/variousArtists";
import { placeMissingRanked } from "../utils/missingTracks";
import { withHostTabs } from "../utils/hostTabs";

interface ArtistDetailProps {
  name: string;
}

export function ArtistDetail({ name }: ArtistDetailProps) {
  const actions = useDetailActions();
  const state = useDetailState();
  const {
    entity,
    sortedTracks,
    albums,
    isLibrary,
    sortField,
    sortDir,
    handleSort,
    sortIndicator,
    trackPopularity,
    rankedTracks,
    rankedValues,
    rankedTypeId,
    filterQuery,
    setFilterQuery,
    handleToggleLike: handleToggleArtistLike,
    handleToggleDislike: handleToggleArtistDislike,
    handleToggleAlbumLike,
    handleToggleAlbumDislike,
  } = useEntityDetail({ kind: "artist", name, invokeInfoFetch: actions.invokeInfoFetch, onEntityLike: actions.toggleEntityLike, onEntityDislike: actions.toggleEntityDislike, reloadSignal: state.bulkEditKey });

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
        return { id: artist.id, imageSrc: imgPath ? resolveImageUrl(imgPath) : undefined };
      }
      return imgPath ? { imageSrc: resolveImageUrl(imgPath) } : undefined;
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

  const handleInfoAction = useInfoSectionActions();

  const infoEntity: InfoEntity = artist
    ? { kind: "artist", name: artist.name, id: artist.id }
    : { kind: "artist", name, id: 0 };

  // A tagger placeholder — "Various Artists", "Unknown Artist" — is a real,
  // navigable artist row (it owns the albums filed under it) but not a real
  // musician: external metadata for the name — Last.fm bio, similar artists,
  // scrobble stats — is junk describing a catch-all entity. Skip those fetches
  // and render only library-derived content (the Albums tab, the hero).
  const placeholder = isVariousArtists(name);

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
      filters: IMAGE_PICKER_FILTERS,
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
    },
    pluginItems: actions.buildPluginOverflowItems({
      kind: "artist",
      artistId: artist?.id ?? undefined,
      artistName: name,
    }),
  });

  const handleEnqueueAll = useCallback(() => {
    actions.enqueueTracks(sortedTracks.filter(t => t.liked !== -1));
  }, [actions.enqueueTracks, sortedTracks]);

  // The artist's Top Songs the user doesn't own, merged into the track list as
  // read-only "Not in library" rows (see MissingTrackRow). A ranked list has no
  // album position: sorted by popularity they fall in by listener count, so the
  // list reads as one ranking; otherwise they follow the owned rows in rank
  // order. Not for a placeholder artist, whose Last.fm data describes nothing.
  const mergeTopTracks = !placeholder && sortedTracks.length > 0 && rankedTracks.length > 0;
  const missingRows = useMemo<MissingTrackRow[]>(() => {
    if (!mergeTopTracks) return [];
    const libraryValues = sortedTracks.map(t => (t.id != null ? trackPopularity[t.id] : undefined) ?? 0);
    const byValue = sortField === "popularity" ? sortDir : null;
    return placeMissingRanked(sortedTracks, libraryValues, rankedTracks, rankedValues, byValue).map(({ providerIndex, before }) => ({
      track: rankedTracks[providerIndex],
      before,
      popularity: rankedValues[providerIndex] || undefined,
    }));
  }, [mergeTopTracks, sortedTracks, trackPopularity, rankedTracks, rankedValues, sortField, sortDir]);

  // The list's local filter, over library and "Not in library" rows alike.
  // Hero Play / Enqueue keep acting on the whole artist.
  const listRowCount = sortedTracks.length + missingRows.length;
  const filterable = showDetailFilter(listRowCount);
  const visible = useMemo(
    () => filterable ? filterDetailRows(sortedTracks, missingRows, filterQuery) : { tracks: sortedTracks, missingRows },
    [filterable, sortedTracks, missingRows, filterQuery],
  );
  const visibleRowCount = visible.tracks.length + visible.missingRows.length;

  // Keyed on the type id (known before the provider answers), not on the
  // rows: a late `exclude` change reloads every section.
  const hideTopSongsTab = !placeholder && sortedTracks.length > 0 && rankedTypeId != null;

  const { playExternal, enqueueExternal, handleInfoTrackContextMenu } = actions;
  const playOneExternal = useCallback((t: QueueTrack) => {
    playExternal([t], 0);
  }, [playExternal]);
  const enqueueOneExternal = useCallback((t: QueueTrack) => {
    enqueueExternal([t]);
  }, [enqueueExternal]);
  const handleMissingContextMenu = useCallback((e: React.MouseEvent, t: QueueTrack) => {
    handleInfoTrackContextMenu(e, { title: t.title, artistName: t.artist_name, albumTitle: t.album_title });
  }, [handleInfoTrackContextMenu]);
  const { startRadioByName, navigateToTrackByName } = actions;
  const startRadioMissing = useCallback((t: QueueTrack) => {
    startRadioByName(t.title, t.artist_name, t.album_title);
  }, [startRadioByName]);
  const locateMissing = useCallback((t: QueueTrack) => {
    navigateToTrackByName(t.title, t.artist_name ?? undefined, t.album_title ?? undefined);
  }, [navigateToTrackByName]);

  const meta: Array<string | { label: string; onClick: () => void }> = [];
  // Both counts are already omitted at 0 — an album-artist-only artist (0 own
  // tracks, see utils/artistCount.ts) shows only its album count here, so this
  // page never needed the tracks-or-albums fallback the list rows use.
  if (isLibrary && artist?.track_count) meta.push(`${artist.track_count} ${artist.track_count === 1 ? "track" : "tracks"}`);
  if (albums.length > 0) meta.push(`${albums.length} ${albums.length === 1 ? "album" : "albums"}`);
  if (missingRows.length > 0) meta.push(`${rankedTracks.length - missingRows.length} of top ${rankedTracks.length} songs in library`);

  // Below the Albums strip: one tab bar — All Tracks first (the track list,
  // Top Songs the user lacks merged in), then Tags, then the plugin sections
  // (About, Similar Artists, …). A saved order that predates these host tabs
  // gets them first (withHostTabs); the user can drag them anywhere after.
  const customTabs: Array<{ id: string; name: string; content: React.ReactNode }> = [];
  if (sortedTracks.length > 0) {
    customTabs.push({
      id: "tracks",
      name: "All Tracks",
      content: (
        <>
          {filterable && (
            <DetailTrackFilter query={filterQuery} onQueryChange={setFilterQuery} total={listRowCount} shown={visibleRowCount} />
          )}
          <TrackList
            tracks={visible.tracks}
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
            trackPopularity={trackPopularity}
            missingRows={visible.missingRows}
            onPlayMissing={playOneExternal}
            onEnqueueMissing={enqueueOneExternal}
            onStartRadioMissing={startRadioMissing}
            onLocateMissing={locateMissing}
            onDownloadMissing={actions.downloadByName ?? undefined}
            onMissingContextMenu={handleMissingContextMenu}
            emptyMessage={visibleRowCount < listRowCount ? "No tracks match the filter." : "No tracks found for this artist."}
          />
        </>
      ),
    });
    customTabs.push({ id: "tags", name: "Tags", content: <EntityTagPanel tracks={sortedTracks} embedded addFirst emptyText="This artist's tracks have no tags yet." /> });
  }
  const tabOrder = withHostTabs(belowTabOrder, customTabs.map(t => t.id));

  return (
    <div className="artist-detail">
      <DetailHero
        bgImages={heroImages}
        bgClassName="detail-hero-bg"
        onBack={actions.canGoBack ? actions.goBack : undefined}
        art={
          artistImagePath
            ? <img src={artistImageUrl} alt={name} />
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
        titleLine={placeholder ? undefined : <TitleLineInfo entity={infoEntity} invokeInfoFetch={actions.invokeInfoFetch} />}
      />
      <div className="section-wide">
        <InformationSections
          entity={infoEntity}
          exclude={["artist_stats"]}
          // This strip only hosts the Albums tab — "header" placement shows no plugin
          // section — so skip their fetches (the tab bar below runs them).
          pluginSectionsDisabled
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
                      <LikeDislikeButtons
                        liked={a.liked}
                        onToggleLike={() => handleToggleAlbumLike(a.id)}
                        onToggleDislike={() => handleToggleAlbumDislike(a.id)}
                        variant="overlay"
                        size={12}
                      />
                      <button className="ds-card-play" title="Play album" onClick={(e) => {
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

      <div className="section-wide">
        <InformationSections
          entity={infoEntity}
          exclude={hideTopSongsTab ? ["artist_stats", rankedTypeId] : ["artist_stats"]}
          pluginSectionsDisabled={placeholder}
          placement="below"
          customTabs={customTabs.length > 0 ? customTabs : undefined}
          invokeInfoFetch={actions.invokeInfoFetch}
          pluginNames={actions.pluginNames}
          retrieve={actions.retrieve}
          tabOrder={tabOrder}
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
