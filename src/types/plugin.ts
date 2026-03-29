import type { Track, HistoryEntry, HistoryMostPlayed } from "../types";

// -- Manifest types --

export interface PluginManifestSidebarItem {
  id: string;
  label: string;
  icon: string;
}

export interface PluginManifestContextMenuItem {
  id: string;
  label: string;
  targets: PluginTargetKind[];
}

export type PluginTargetKind = "track" | "album" | "artist" | "multi-track";

export type PluginEventName =
  | "track:started"
  | "track:played"
  | "track:scrobbled"
  | "track:liked";

export interface PluginManifestContributes {
  sidebarItems?: PluginManifestSidebarItem[];
  contextMenuItems?: PluginManifestContextMenuItem[];
  eventHooks?: PluginEventName[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  minAppVersion?: string;
  contributes?: PluginManifestContributes;
}

// -- Installed plugin from backend --

export interface InstalledPlugin {
  id: string;
  manifest: PluginManifest;
  builtin?: boolean;
}

// -- Plugin status --

export type PluginStatus = "active" | "error" | "incompatible" | "disabled";

export interface PluginState {
  id: string;
  manifest: PluginManifest;
  status: PluginStatus;
  error?: string;
  enabled: boolean;
  builtin?: boolean;
}

// -- Plugin-facing context menu target --

export interface PluginContextMenuTarget {
  kind: PluginTargetKind;
  trackId?: number;
  title?: string;
  artistName?: string;
  albumId?: number;
  albumTitle?: string;
  artistId?: number;
  trackIds?: number[];
}

// -- View data types --

export interface CardGridItem {
  id: string;
  title: string;
  subtitle?: string;
  imageUrl?: string;
  action?: string;
}

export interface StatItem {
  label: string;
  value: string | number;
}

export type PluginViewData =
  | { type: "track-list"; tracks: Track[]; title?: string }
  | { type: "card-grid"; items: CardGridItem[]; columns?: number }
  | { type: "text"; content: string }
  | { type: "stats-grid"; items: StatItem[] }
  | { type: "button"; label: string; action: string }
  | {
      type: "layout";
      direction: "vertical" | "horizontal";
      children: PluginViewData[];
    }
  | { type: "spacer" };

// -- Plugin API (what plugins receive) --

export interface PluginLibraryAPI {
  getTracks(opts?: {
    artistId?: number;
    albumId?: number;
    tagId?: number;
    limit?: number;
  }): Promise<Track[]>;
  getArtists(): Promise<
    Array<{ id: number; name: string; track_count: number }>
  >;
  getAlbums(): Promise<
    Array<{
      id: number;
      title: string;
      artist_name: string | null;
      year: number | null;
    }>
  >;
  getTrackById(id: number): Promise<Track | null>;
  search(query: string): Promise<Track[]>;
  getHistory(opts?: { limit?: number }): Promise<HistoryEntry[]>;
  getMostPlayed(opts?: {
    limit?: number;
    days?: number;
  }): Promise<HistoryMostPlayed[]>;
}

export interface PluginPlaybackAPI {
  getCurrentTrack(): Track | null;
  isPlaying(): boolean;
  getPosition(): number;
  onTrackStarted(handler: (track: Track) => void): () => void;
  onTrackPlayed(handler: (track: Track) => void): () => void;
  onTrackScrobbled(handler: (track: Track) => void): () => void;
  onTrackLiked(handler: (track: Track, liked: boolean) => void): () => void;
}

export interface PluginContextMenuAPI {
  onAction(
    actionId: string,
    handler: (target: PluginContextMenuTarget) => void,
  ): void;
}

export interface PluginUIAPI {
  setViewData(viewId: string, data: PluginViewData): void;
  showNotification(message: string): void;
  onAction(actionId: string, handler: (data: unknown) => void): void;
}

export interface PluginStorageAPI {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface PluginNetworkAPI {
  fetch(
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<{
    status: number;
    text(): Promise<string>;
    json(): Promise<unknown>;
  }>;
}

export interface ViboplrPluginAPI {
  library: PluginLibraryAPI;
  playback: PluginPlaybackAPI;
  contextMenu: PluginContextMenuAPI;
  ui: PluginUIAPI;
  storage: PluginStorageAPI;
  network: PluginNetworkAPI;
}

// -- Registry types (internal to usePlugins) --

export interface PluginSidebarItem {
  pluginId: string;
  id: string;
  label: string;
  icon: string;
}

export interface PluginMenuItem {
  pluginId: string;
  id: string;
  label: string;
  targets: PluginTargetKind[];
}

export interface PluginRegistry {
  plugins: PluginState[];
  sidebarItems: PluginSidebarItem[];
  menuItems: PluginMenuItem[];
  viewData: Map<string, PluginViewData>;
}
