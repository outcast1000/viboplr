import { createContext, useContext, useMemo } from "react";
import type { Track, QueueTrack } from "../types";
import type { PlaylistContext } from "../hooks/useQueue";
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";
import type { SearchProviderConfig } from "../searchProviders";
import type { OpenInfoArgs } from "../hooks/useRetrieveModal";

export interface DetailViewActions {
  navigateToArtist: (id: number, name?: string) => void;
  navigateToAlbum: (id: number, artistId?: number | null, name?: string, artistName?: string) => void;
  navigateToTag: (id: number) => void;
  navigateToTagByName: (name: string) => void;

  playTracks: (tracks: Track[], index: number, context?: PlaylistContext | null) => void;
  playEntityAll: (kind: "artist" | "album" | "tag", name: string, artistName?: string, opts?: { tracks?: Track[]; entityId?: number }) => void;
  playAlbum: (albumId: number, opts?: { tracks?: Track[]; startIndex?: number }) => void;
  enqueueTracks: (tracks: Track[]) => void;
  playExternal: (tracks: QueueTrack[]) => void;
  enqueueExternal: (tracks: QueueTrack[]) => void;

  toggleLike: (track: Track | QueueTrack) => void;
  toggleDislike: (track: Track | QueueTrack) => void;
  toggleEntityLike: (kind: "artist" | "album" | "tag", id: number) => void;
  toggleEntityDislike: (kind: "artist" | "album" | "tag", id: number) => void;
  deleteTracks: (trackIds: number[]) => void;

  handleTrackContextMenu: (e: React.MouseEvent, track: Track, selectedIds: Set<string>) => void;
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
  pluginNames: Map<string, string>;
  searchProviders: SearchProviderConfig[];
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
}

const ActionsContext = createContext<DetailViewActions | null>(null);
const StateContext = createContext<DetailViewState>({ currentTrack: null, playing: false });

export function useDetailActions(): DetailViewActions {
  const ctx = useContext(ActionsContext);
  if (!ctx) throw new Error("useDetailActions must be used within DetailViewProvider");
  return ctx;
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
    actions.playTracks, actions.playEntityAll, actions.playAlbum, actions.enqueueTracks,
    actions.toggleLike, actions.toggleDislike, actions.toggleEntityLike, actions.toggleEntityDislike, actions.deleteTracks,
    actions.handleTrackContextMenu, actions.handleAlbumContextMenu,
    actions.handleInfoTrackContextMenu, actions.handleEntityContextMenu,
    actions.handleTrackDragStart,
    actions.getArtistImage, actions.getAlbumImage, actions.getTagImage,
    actions.invalidateImage, actions.requestFetchImage, actions.autoFetchImage,
    actions.invokeInfoFetch, actions.pluginNames, actions.searchProviders,
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
