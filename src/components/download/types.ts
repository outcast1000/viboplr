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
  /** True when this is a video track (set by the caller from the track's
   *  authoritative format). Makes the modal default to a provider `video`
   *  quality option so downloading a video you're watching yields the video. */
  isVideo?: boolean;
}

/** What the modal is for. `"import"`: the files are already on this computer
 *  (a plugin's finished downloads — Soulseek's "Add to library…") and the
 *  modal only copies them into a collection, so it must not say "Download".
 *  The flow is the same; only the words change. */
export type DownloadPurpose = "download" | "import";

export interface DownloadWording {
  singleTitle: string;
  multiTitle: (n: number) => string;
  start: string;
  startMany: (n: number) => string;
  startAnyway: string;
  working: (providerName: string) => string;
  workingMany: string;
  done: string;
  failed: string;
  summary: (done: number, total: number) => string;
}

export function downloadWording(purpose: DownloadPurpose | undefined): DownloadWording {
  const plural = (n: number) => `${n} track${n !== 1 ? "s" : ""}`;
  if (purpose === "import") {
    return {
      singleTitle: "Add to library",
      multiTitle: (n) => `Add ${plural(n)} to library`,
      start: "Add to library",
      startMany: (n) => `Add ${plural(n)}`,
      startAnyway: "Add anyway",
      working: () => "Copying into your library…",
      workingMany: "Adding to library",
      done: "Added to library",
      failed: "Couldn't add to library",
      summary: (done, total) => `Added ${done} of ${total} tracks to the library`,
    };
  }
  return {
    singleTitle: "Download track",
    multiTitle: (n) => `Download ${n} tracks`,
    start: "Download",
    startMany: (n) => `Download ${plural(n)}`,
    startAnyway: "Download anyway",
    working: (providerName) => `Downloading from ${providerName}...`,
    workingMany: "Downloading tracks",
    done: "Download complete",
    failed: "Download failed",
    summary: (done, total) => `Downloaded ${done} of ${total} tracks`,
  };
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
  /** What the provider says it is doing ("Downloading video · 8 MiB/s"). */
  stage?: string;
  /** The provider's resolve produced a local file; the copy into place
   *  doesn't drive the row's percentage. */
  savingLocal?: boolean;
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
