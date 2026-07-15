import type { DockSide, FitMode } from "../hooks/useVideoLayout";
import type { PluginContextMenuTarget } from "./plugin";
import { parseLibraryId } from "../queueEntry";

/**
 * Portable metadata for the currently-playing video track, carried on the
 * `video` context-menu target so the menu can offer the same track actions
 * (Open Containing Folder, Move to Trash, …) as any other track surface.
 * The video is always a `QueueTrack` (no DB id), so ids resolve on demand from
 * `key`/`path` at action time — same pattern as the queue context menu.
 */
export interface VideoMenuTrack {
  key: string;
  path: string | null;
  title: string;
  artistName: string | null;
  durationSecs: number | null;
  isLocal: boolean;
}

export type ContextMenuTarget =
  | { kind: "track"; trackId?: number; isLocal?: boolean; title: string; artistName: string | null }
  | { kind: "album"; albumId?: number; title: string; artistName: string | null }
  | { kind: "artist"; artistId?: number; name: string }
  | { kind: "tag"; tagId: number; name: string }
  | { kind: "multi-track"; trackIds: number[] }
  | { kind: "multi-album"; albumIds: number[] }
  | { kind: "multi-artist"; artistIds: number[] }
  | { kind: "multi-tag"; tagIds: number[] }
  | { kind: "queue-multi"; indices: number[]; trackIds: number[]; firstTrack: { title: string; artistName: string | null; isLocal: boolean } }
  | { kind: "video"; dockSide: DockSide; fitMode: FitMode; track?: VideoMenuTrack };

export interface ContextMenuState {
  x: number;
  y: number;
  target: ContextMenuTarget;
}

export function toPluginTarget(target: ContextMenuTarget): PluginContextMenuTarget {
  switch (target.kind) {
    case "track": return { kind: "track", trackId: target.trackId, title: target.title, artistName: target.artistName ?? undefined, isLocal: target.isLocal };
    case "album": return { kind: "album", albumId: target.albumId, albumTitle: target.title, artistName: target.artistName ?? undefined };
    case "artist": return { kind: "artist", artistId: target.artistId, artistName: target.name };
    case "multi-track": return { kind: "multi-track", trackIds: target.trackIds };
    case "queue-multi":
      if (target.trackIds.length === 1) {
        return { kind: "track", trackId: target.trackIds[0], title: target.firstTrack.title, artistName: target.firstTrack.artistName ?? undefined, isLocal: target.firstTrack.isLocal };
      }
      return { kind: "multi-track", trackIds: target.trackIds };
    case "video":
      return target.track
        ? { kind: "track", trackId: parseLibraryId(target.track.key) ?? undefined, title: target.track.title, artistName: target.track.artistName ?? undefined, isLocal: target.track.isLocal }
        : { kind: "track" };
    default: return { kind: "track" };
  }
}
