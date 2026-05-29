// Shared types for the download modal family (split out of DownloadModal.tsx).
import type { Track } from "../../types";
import type { InteractiveSearchResult } from "../../types/plugin";

export interface DownloadTrack {
  title: string;
  artistName?: string | null;
  albumTitle?: string | null;
  uri?: string | null;
  durationSecs?: number | null;
  trackId?: number | null;
}

export interface UpgradePreviewInfo {
  old_path: string;
  old_format: string | null;
  old_file_size: number | null;
  new_path: string;
  new_format: string | null;
  new_file_size: number | null;
}

export interface ConflictCheck {
  has_conflict: boolean;
  dest_path: string;
  existing_size: number | null;
  existing_format: string | null;
}

export interface DownloadResult {
  path: string;
  format: string;
  file_size: number;
}

export type ExistingAction = "skip" | "download" | "overwrite";

export interface ResolveState {
  originalTrack: DownloadTrack;
  status: "pending" | "searching" | "matched" | "not_found";
  match?: InteractiveSearchResult | null;
  libraryTrack?: Track | null;
  existingAction?: ExistingAction;
}

export type BatchDownloadStatus = "queued" | "downloading" | "done" | "error" | "skipped";

export interface BatchDownloadTrackState {
  index: number;
  title: string;
  artist: string;
  status: BatchDownloadStatus;
  progress: number;
  error?: string;
  filePath?: string;
}

export interface BatchConflict {
  trackIndex: number;
  destPath: string;
  existingSize: number | null;
  existingFormat: string | null;
  altPath: string;
}
