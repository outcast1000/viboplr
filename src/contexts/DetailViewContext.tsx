import { createContext, useCallback, useContext, useMemo } from "react";
import type { Track, QueueTrack } from "../types";
import type { PlaylistContext } from "../hooks/useQueue";
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";
import type { PluginContextMenuTarget } from "../types/plugin";
import type { HeroOverflowItem } from "../utils/heroOverflow";
import type { OpenInfoArgs } from "../hooks/useRetrieveModal";

export interface DetailViewActions {
  navigateToArtist: (id: number, name?: string) => void;
  navigateToAlbum: (id: number, artistId?: number | null, name?: string, artistName?: string) => void;
  navigateToTag: (id: number) => void;
  navigateToTagByName: (name: string) => void;

  /** Navigate back through history (mirrors the caption-bar back arrow). */
  goBack: () => void;
  /** Whether there is history to go back to (gates the hero back button). */
  canGoBack: boolean;

  playTracks: (tracks: Track[], index: number, context?: PlaylistContext | null) => void;
  playEntityAll: (kind: "artist" | "album" | "tag", name: string, artistName?: string, opts?: { tracks?: Track[]; entityId?: number }) => void;
  playAlbum: (albumId: number, opts?: { tracks?: Track[]; startIndex?: number }) => void;
  enqueueTracks: (tracks: Track[]) => void;
  playExternal: (tracks: QueueTrack[], startIndex?: number, context?: PlaylistContext | null) => void;
  enqueueExternal: (tracks: QueueTrack[]) => void;
  /** Start a radio station seeded from a single track (overlay "radio" action). */
  startRadio: (track: Track) => void;
  /** Open a track's detail page (overlay "info" action). */
  locateTrack: (track: Track) => void;
  /** Start radio from a track known only by name — one the library may lack
   *  (a "Not in library" row); the station then opens with it, metadata-only. */
  startRadioByName: (title: string, artistName: string | null, albumTitle?: string | null) => void;
  /** Open a track's detail page by name (the name-only page when the library
   *  has no such track). */
  navigateToTrackByName: (name: string, artistName?: string, albumTitle?: string) => void;

  toggleLike: (track: Track | QueueTrack) => void;
  toggleDislike: (track: Track | QueueTrack) => void;
  toggleEntityLike: (kind: "artist" | "album" | "tag", id: number) => void;
  toggleEntityDislike: (kind: "artist" | "album" | "tag", id: number) => void;
  /** Set an artist/album/tag like by name — for a detail page whose entity
   *  isn't in the library (no id to toggle). Likes are name-keyed, so the write
   *  lands either way. Resolves whether it was saved. */
  setEntityLikeByName: (kind: "artist" | "album" | "tag", name: string, artistName: string | undefined, likeState: number) => Promise<boolean>;
  deleteTracks: (trackIds: number[]) => void;

  handleTrackContextMenu: (e: React.MouseEvent, track: Track, selectedTracks: Track[]) => void;
  handleAlbumContextMenu: (e: React.MouseEvent, albumId: number) => void;
  handleInfoTrackContextMenu: (e: React.MouseEvent, info: { trackId?: number; title: string; artistName: string | null }) => void;
  handleEntityContextMenu: (e: React.MouseEvent, info: { kind: "track" | "artist" | "album"; id?: number; name: string; artistName?: string | null }) => void;

  handleTrackDragStart: (tracks: Track[]) => void;

  getArtistImage: (name: string) => string | null;
  getAlbumImage: (title: string, artistName?: string | null) => string | null;
  getTagImage: (name: string) => string | null;
  invalidateImage: (kind: "artist" | "album" | "tag", name: string, artistName?: string) => void;
  /** Explicit user action (hero refresh button): opens the Retrieve modal. */
  requestFetchImage: (kind: "artist" | "album" | "tag", name: string, artistName?: string) => void;
  /** Silent background fetch for lazy hero-image resolution (no modal). */
  autoFetchImage: (kind: "artist" | "album" | "tag", name: string, artistName?: string) => void;

  invokeInfoFetch: (pluginId: string, infoTypeId: string, entity: InfoEntity, onFetchUrl?: (url: string) => void) => Promise<InfoFetchResult>;
  /** Whether the plugin system finished its async startup load — lets tag
   *  surfaces re-fetch Last.fm community tags once the plugin is ready. */
  pluginsLoaded: boolean;
  pluginNames: Map<string, string>;
  /** Build detail-page ⋯ overflow items from plugin context-menu items for an
   *  entity (e.g. the search-providers "Search" submenu). */
  buildPluginOverflowItems: (target: PluginContextMenuTarget) => HeroOverflowItem[];
  /** Ranked library tag pool (buildTagSuggestionPool output) for tag editors. */
  tagSuggestionPool: string[];
  /** Refresh library tag state after an entity-wide tag write (counts, removals). */
  refreshLibraryTags: () => void;
  /** Opens the centered Retrieve modal for a user-triggered info-section refresh. */
  retrieve: {
    openInfo: (args: OpenInfoArgs) => void;
  };
}

export interface DetailViewState {
  currentTrack: QueueTrack | null;
  playing: boolean;
  /** Bumped whenever a bulk edit (Edit Properties) completes. Detail views feed
   *  this into `useEntityDetail` so they re-fetch their tracks — indexed fields
   *  (album/artist/title) and tag-only edits aren't captured by the in-place
   *  trackEvents patch, and moving a track to another album must drop it here. */
  bulkEditKey: number;
}

const ActionsContext = createContext<DetailViewActions | null>(null);
const StateContext = createContext<DetailViewState>({ currentTrack: null, playing: false, bulkEditKey: 0 });

export function useDetailActions(): DetailViewActions {
  const ctx = useContext(ActionsContext);
  if (!ctx) throw new Error("useDetailActions must be used within DetailViewProvider");
  return ctx;
}

/** The `onAction` handler every detail page gives `InformationSections`.
 *  Tracks arrive metadata-only (`buildExternalQueueTrack`) and are queued as
 *  they are — the stream-resolver chain finds a source at play time, the
 *  Library resolver first, so a track the user owns plays their copy.
 *  - `play-track` / `enqueue-track`: one track.
 *  - `play-tracks`: a whole list (e.g. Similar Tracks) from `startIndex`, so
 *    the rest of the list follows the clicked track in the queue. */
export function useInfoSectionActions(): (actionId: string, payload?: unknown) => void {
  const { playExternal, enqueueExternal } = useDetailActions();
  return useCallback((actionId: string, payload?: unknown) => {
    if (actionId === "play-track") {
      const t = payload as QueueTrack | undefined;
      if (t) playExternal([t]);
    } else if (actionId === "enqueue-track") {
      const t = payload as QueueTrack | undefined;
      if (t) enqueueExternal([t]);
    } else if (actionId === "play-tracks") {
      const p = payload as { tracks: QueueTrack[]; startIndex: number; context?: PlaylistContext | null } | undefined;
      if (p?.tracks.length) playExternal(p.tracks, p.startIndex, p.context ?? null);
    }
  }, [playExternal, enqueueExternal]);
}

export function useDetailState(): DetailViewState {
  return useContext(StateContext);
}

interface DetailViewProviderProps {
  actions: DetailViewActions;
  state: DetailViewState;
  children: React.ReactNode;
}

export function DetailViewProvider({ actions, state, children }: DetailViewProviderProps) {
  const stableActions = useMemo(() => actions, [
    actions.navigateToArtist, actions.navigateToAlbum, actions.navigateToTag, actions.navigateToTagByName,
    actions.goBack, actions.canGoBack,
    actions.playTracks, actions.playEntityAll, actions.playAlbum, actions.enqueueTracks,
    actions.playExternal, actions.enqueueExternal,
    actions.startRadio, actions.locateTrack, actions.startRadioByName, actions.navigateToTrackByName,
    actions.toggleLike, actions.toggleDislike, actions.toggleEntityLike, actions.toggleEntityDislike,
    actions.setEntityLikeByName, actions.deleteTracks,
    actions.handleTrackContextMenu, actions.handleAlbumContextMenu,
    actions.handleInfoTrackContextMenu, actions.handleEntityContextMenu,
    actions.handleTrackDragStart,
    actions.getArtistImage, actions.getAlbumImage, actions.getTagImage,
    actions.invalidateImage, actions.requestFetchImage, actions.autoFetchImage,
    actions.invokeInfoFetch, actions.pluginsLoaded, actions.pluginNames, actions.buildPluginOverflowItems,
    actions.tagSuggestionPool, actions.refreshLibraryTags,
    actions.retrieve,
  ]);

  return (
    <ActionsContext.Provider value={stableActions}>
      <StateContext.Provider value={state}>
        {children}
      </StateContext.Provider>
    </ActionsContext.Provider>
  );
}
