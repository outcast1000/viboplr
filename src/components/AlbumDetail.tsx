import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { IMAGE_PICKER_FILTERS } from "../utils/imageFileFilters";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Album, ColumnConfig, QueueTrack } from "../types";

import { ALBUM_DETAIL_COLUMNS } from "../hooks/useLibrary";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { useDetailActions, useDetailState, useInfoSectionActions } from "../contexts/DetailViewContext";
import { TrackList } from "./TrackList";
import { PromptModal } from "./PromptModal";
import { InformationSections } from "./InformationSections";
import { TitleLineInfo } from "./TitleLineInfo";
import { DetailHero } from "./DetailHero";
import { EntityTagPanel } from "./EntityTagPanel";
import { buildHeroOverflowItems, type HeroOverflowItem } from "../utils/heroOverflow";
import type { InfoEntity } from "../types/informationTypes";
import { store } from "../store";
import { useDetailHeroImages } from "../hooks/useDetailHeroImages";
import { resolveImageUrl } from "../utils/resolveImageUrl";
import { TrackRow, type TrackRowThumb } from "./TrackRow";
import { trackLikeId } from "../utils/likeReconcile";
import { formatCompactCount } from "../utils/formatCount";
import { placeMissingTracks } from "../utils/missingTracks";
import { withHostTabs } from "../utils/hostTabs";
import type { MissingTrackRow } from "./TrackList";

const TRACKS_TAB_ID = "tracks";
const TAGS_TAB_ID = "tags";

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
    reload,
    loaded,
    liked,
    rankedTracks,
    rankedValues,
    rankedStatus,
    rankedTypeId,
  } = useEntityDetail({ kind: "album", name, artistName, invokeInfoFetch: actions.invokeInfoFetch, onEntityLike: actions.toggleEntityLike, onEntityDislike: actions.toggleEntityDislike, onEntityLikeByName: actions.setEntityLikeByName, reloadSignal: state.bulkEditKey });

  const album = entity as Album | null;

  const [trackColumns, setTrackColumns] = useState<ColumnConfig[]>(ALBUM_DETAIL_COLUMNS);
  const trackListRef = useRef<HTMLDivElement>(null);
  const [belowTabOrder, setBelowTabOrder] = useState<string[]>([]);
  const [editingYear, setEditingYear] = useState(false);

  useEffect(() => {
    store.get<string[]>("albumDetailBelowTabOrder").then(saved => {
      if (saved && saved.length > 0) setBelowTabOrder(saved);
    });
  }, []);

  const handleBelowTabOrderChange = useCallback((order: string[]) => {
    setBelowTabOrder(order);
    store.set("albumDetailBelowTabOrder", order);
  }, []);

  const displayArtist = album?.artist_name ?? artistName;
  const albumImagePath = actions.getAlbumImage(name, artistName ?? null);

  // Hero background: the album's own cover first — it is what the page is
  // about — falling back to the artist's image only when there is no cover.
  // The artist lookup is skipped (null name) while a cover exists, so an album
  // that has one costs no artist image fetch.
  const albumHeroUrl = resolveImageUrl(albumImagePath);
  const heroArtistName = albumHeroUrl ? null : album?.artist_name ?? artistName ?? null;
  const requestArtistImage = useCallback(
    (n: string) => actions.autoFetchImage("artist", n),
    [actions.autoFetchImage],
  );
  const artistHeroImages = useDetailHeroImages.singleArtist(
    heroArtistName,
    actions.getArtistImage,
    requestArtistImage,
  );
  const heroImages = albumHeroUrl ? [albumHeroUrl] : artistHeroImages;

  const infoEntity: InfoEntity = album
    ? { kind: "album", name: album.title, id: album.id, artistName: album.artist_name ?? undefined }
    : { kind: "album", name, id: 0, artistName };

  const handleEntityClick = useCallback((kind: string, id?: number, entityName?: string) => {
    if (kind === "artist") actions.navigateToArtist(id ?? 0, entityName);
    else if (kind === "album") actions.navigateToAlbum(id ?? 0, undefined, entityName);
  }, [actions.navigateToArtist, actions.navigateToAlbum]);

  const handleInfoAction = useInfoSectionActions();

  const resolveEntity = useCallback((kind: string, entityName: string) => {
    if (kind === "artist") {
      const imgPath = actions.getArtistImage(entityName);
      return imgPath ? { imageSrc: resolveImageUrl(imgPath) } : undefined;
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

  // Album not in the library: its tracklist comes from the info provider,
  // metadata-only, and plays through the stream resolvers (a library copy of
  // any one track still wins). Same banner context a library album play gets.
  const externalContext = useMemo(() => ({
    name,
    source: "album",
    imagePath: albumImagePath,
    metadata: displayArtist ? { artist: displayArtist } : null,
  }), [name, albumImagePath, displayArtist]);

  const { playExternal, enqueueExternal } = actions;
  const playExternalFrom = useCallback((index: number) => {
    playExternal(rankedTracks, index, externalContext);
  }, [playExternal, rankedTracks, externalContext]);

  const handleEnqueueExternal = useCallback(() => {
    enqueueExternal(rankedTracks);
  }, [enqueueExternal, rankedTracks]);

  // Library album: the provider's tracks the user doesn't own, merged into the
  // track list in album order (or after the owned rows once a column sort
  // makes album position meaningless). Read-only rows — see MissingTrackRow.
  const missingRows = useMemo<MissingTrackRow[]>(() => {
    if (!isLibrary || rankedTracks.length === 0) return [];
    return placeMissingTracks(sortedTracks, rankedTracks, sortField === null).map(({ providerIndex, before }) => ({
      track: rankedTracks[providerIndex],
      before,
      number: providerIndex + 1,
      popularity: rankedValues[providerIndex] || undefined,
    }));
  }, [isLibrary, rankedTracks, rankedValues, sortedTracks, sortField]);

  const playOneExternal = useCallback((t: QueueTrack) => {
    playExternal([t], 0);
  }, [playExternal]);
  const enqueueOneExternal = useCallback((t: QueueTrack) => {
    enqueueExternal([t]);
  }, [enqueueExternal]);
  const { handleInfoTrackContextMenu } = actions;
  const handleMissingContextMenu = useCallback((e: React.MouseEvent, t: QueueTrack) => {
    handleInfoTrackContextMenu(e, { title: t.title, artistName: t.artist_name, albumTitle: t.album_title });
  }, [handleInfoTrackContextMenu]);
  const { startRadioByName, navigateToTrackByName, downloadByName } = actions;
  const startRadioMissing = useCallback((t: QueueTrack) => {
    startRadioByName(t.title, t.artist_name, t.album_title);
  }, [startRadioByName]);
  const locateMissing = useCallback((t: QueueTrack) => {
    navigateToTrackByName(t.title, t.artist_name ?? undefined, t.album_title ?? undefined);
  }, [navigateToTrackByName]);

  const handleRefreshImage = useCallback(() => {
    actions.requestFetchImage("album", name, artistName);
  }, [actions.requestFetchImage, name, artistName]);

  const handleSetImageFromFile = useCallback(async () => {
    const selected = await openFileDialog({
      multiple: false,
      filters: IMAGE_PICKER_FILTERS,
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

  const handleSubmitYear = useCallback(async (value: string) => {
    setEditingYear(false);
    if (!album?.id) return;
    // Empty input clears the year (mirrors the Bulk Edit / Track Properties flow).
    let year: number | null;
    if (value.trim() === "") {
      year = null;
    } else {
      const parsed = parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 9999) return;
      year = parsed;
    }
    if (year === (album.year ?? null)) return;
    try {
      await invoke("set_album_year", { albumId: album.id, year });
      reload();
    } catch (e) { console.error("Failed to set album year:", e); }
  }, [album?.id, album?.year, reload]);

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
    },
    pluginItems: [
      ...(isLibrary && album
        ? [{ kind: "action" as const, id: "edit-year", label: "Edit year…", onClick: () => setEditingYear(true) }]
        : []),
      ...actions.buildPluginOverflowItems({
        kind: "album",
        albumId: album?.id ?? undefined,
        albumTitle: name,
        artistName: displayArtist ?? undefined,
      }),
    ],
  });

  const handleEnqueueAll = useCallback(() => {
    actions.enqueueTracks(sortedTracks.filter(t => t.liked !== -1));
  }, [actions.enqueueTracks, sortedTracks]);

  const eyebrow = album?.year ? `Album · ${album.year}` : "Album";
  const meta: Array<string | { label: string; onClick: () => void }> = [];
  if (displayArtist) meta.push({ label: displayArtist, onClick: () => actions.navigateToArtist(album?.artist_id ?? 0, displayArtist ?? undefined) });
  if (isLibrary && album?.track_count) {
    // "12 of 17 in library" once the provider tracklist shows tracks missing.
    meta.push(missingRows.length > 0
      ? `${sortedTracks.length} of ${sortedTracks.length + missingRows.length} in library`
      : `${album.track_count} tracks`);
  } else if (rankedTracks.length > 0) meta.push(`${rankedTracks.length} tracks`);
  if (loaded && !isLibrary) meta.push("Not in your library");

  const externalThumb: TrackRowThumb = albumHeroUrl ? { kind: "image", url: albumHeroUrl, alt: name } : { kind: "disc" };
  const canPlayExternal = !isLibrary && rankedTracks.length > 0;
  // A provider row has no library id, so "is this the one playing?" is the
  // same normalized title+artist identity likes use.
  const playingId = state.playing && state.currentTrack
    ? trackLikeId(state.currentTrack.title, state.currentTrack.artist_name)
    : null;

  // The track list is the page's main tab, in the same tab bar as the
  // information sections — first, and so selected on arrival, unless the user
  // has dragged it elsewhere (a saved order that predates the tab doesn't name
  // it, so it goes in front). A library album shows its TrackList (missing
  // tracks merged in), with its tags in a Tags tab right after; an album that
  // isn't in the library shows the provider's tracklist.
  const libraryTracksContent = (
    <>
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
        trackPopularity={trackPopularity}
        missingRows={missingRows}
        onPlayMissing={playOneExternal}
        onEnqueueMissing={enqueueOneExternal}
        onStartRadioMissing={startRadioMissing}
        onLocateMissing={locateMissing}
        onDownloadMissing={actions.downloadByName ?? undefined}
        onMissingContextMenu={handleMissingContextMenu}
        emptyMessage="No tracks found."
      />
    </>
  );
  const showTracksTab = isLibrary ? sortedTracks.length > 0 : rankedStatus !== "idle";
  const tracksTab = !showTracksTab ? null : {
    id: TRACKS_TAB_ID,
    name: "Track List",
    content: isLibrary ? libraryTracksContent : rankedStatus === "loading" ? (
      <div className="album-external-note">Looking up the tracklist…</div>
    ) : rankedStatus === "none" ? (
      <div className="album-external-note">No tracklist found for this album.</div>
    ) : (
      <div className="entity-list album-external-tracks">
        {rankedTracks.map((t, i) => (
          <TrackRow
            key={t.key}
            leading={<span className="album-external-num">{i + 1}</span>}
            thumb={externalThumb}
            title={t.title}
            subtitle={t.artist_name ?? undefined}
            meta={rankedValues[i] ? <span title={`${rankedValues[i].toLocaleString()} listeners`}>{formatCompactCount(rankedValues[i])}</span> : undefined}
            playing={playingId !== null && playingId === trackLikeId(t.title, t.artist_name)}
            onDoubleClick={() => playExternalFrom(i)}
            onContextMenu={(e) => { e.preventDefault(); actions.handleInfoTrackContextMenu(e, { title: t.title, artistName: t.artist_name, albumTitle: t.album_title }); }}
            actions={{
              onPlay: () => playExternalFrom(i),
              onEnqueue: () => enqueueExternal([t]),
              onDownload: downloadByName ? () => downloadByName(t) : undefined,
            }}
          />
        ))}
      </div>
    ),
  };
  // The album's tags (library albums only — the tags live on library rows).
  const tagsTab = isLibrary && sortedTracks.length > 0 ? {
    id: TAGS_TAB_ID,
    name: "Tags",
    content: (
      <EntityTagPanel
        tracks={sortedTracks}
        embedded
        addFirst
        intro={<>Tags here apply to every track on this album. A count like <strong>1/2</strong> means only some tracks have it — <strong>↑</strong> adds it to the rest, <strong>×</strong> removes it from all.</>}
        emptyText="This album has no tags yet."
      />
    ),
  } : null;
  const customTabs = [tracksTab, tagsTab].filter((t): t is NonNullable<typeof t> => t !== null);

  // Host tabs a saved order doesn't name yet (it predates them) are put where
  // they belong: Track List first, Tags right after it.
  const tabOrder = withHostTabs(belowTabOrder, customTabs.map(t => t.id));

  return (
    <div className="album-detail">
      <DetailHero
        bgImages={heroImages}
        bgClassName="detail-hero-bg"
        onBack={actions.canGoBack ? actions.goBack : undefined}
        art={
          albumImagePath ? (
            <img src={resolveImageUrl(albumImagePath)} alt={name} />
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
        liked={isLibrary || loaded ? liked : undefined}
        onToggleLike={isLibrary || loaded ? handleToggleAlbumLike : undefined}
        onToggleDislike={isLibrary || loaded ? handleToggleAlbumDislike : undefined}
        entityLabel="album"
        meta={meta}
        onPlay={sortedTracks.length > 0 ? handlePlayAll : canPlayExternal ? () => playExternalFrom(0) : undefined}
        onEnqueue={sortedTracks.length > 0 ? handleEnqueueAll : canPlayExternal ? handleEnqueueExternal : undefined}
        overflowItems={overflowItems}
        titleLine={<TitleLineInfo entity={infoEntity} invokeInfoFetch={actions.invokeInfoFetch} />}
      />

      <div className="section-wide">
        <InformationSections
          entity={infoEntity}
          exclude={rankedTypeId ? [rankedTypeId] : []}
          placement="below"
          invokeInfoFetch={actions.invokeInfoFetch}
          pluginNames={actions.pluginNames}
          retrieve={actions.retrieve}
          tabOrder={tabOrder}
          onTabOrderChange={handleBelowTabOrderChange}
          customTabs={customTabs.length > 0 ? customTabs : undefined}
          onEntityClick={handleEntityClick}
          onAction={handleInfoAction}
          resolveEntity={resolveEntity}
          onTrackContextMenu={actions.handleInfoTrackContextMenu}
          onEntityContextMenu={actions.handleEntityContextMenu}
        />
      </div>

      {editingYear && (
        <PromptModal
          title="Edit album year"
          label="Enter a four-digit year, or leave blank to clear it."
          defaultValue={album?.year ? String(album.year) : ""}
          placeholder="e.g. 2001"
          allowEmpty
          onSubmit={handleSubmitYear}
          onCancel={() => setEditingYear(false)}
        />
      )}
    </div>
  );
}
