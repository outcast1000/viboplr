import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { safeUnlisten } from "../utils/tauriEvents";
import type { QueueTrack } from "../types";
import { nextExternalKey } from "../queueEntry";

/** One media file resolved from an OS file-manager drop (see the Rust
 * `resolve_dropped_paths` command / `DroppedTrack`). */
interface DroppedTrack {
  path: string;
  title: string;
  artist_name: string | null;
  album_title: string | null;
  duration_secs: number | null;
  format: string | null;
}

interface UseFileDropDeps {
  /** Dedup-aware enqueue (App's `contextMenuActions.handleEnqueue`). Loosely
   * typed there — it only touches `path`/`key`, so QueueTracks are fine. When
   * duplicates are already queued it defers to the confirmation banner instead
   * of appending, so the "added" toast below is gated on `findDuplicates`. */
  enqueue: (tracks: QueueTrack[]) => void;
  /** Duplicate check against the current queue (App's `queueHook.findDuplicates`),
   * so we only toast "added" when the enqueue actually appended. */
  findDuplicates: (tracks: QueueTrack[]) => { duplicates: QueueTrack[]; unique: QueueTrack[] };
  /** Reveal the queue so the just-added tracks are visible. */
  expandQueue: () => void;
  /** Lightweight user feedback (toast). */
  notify: (message: string) => void;
}

/**
 * Drag-and-drop of files/folders from the OS file manager (Finder/Explorer)
 * into the app to enqueue them.
 *
 * This is the *native* OS drag-drop path — distinct from the app's internal
 * mouse-based dragging (the drag-and-drop skill's WKWebView rule is about the
 * latter and does not apply here). Tauri captures the OS drop and hands us
 * absolute file paths via the webview's `onDragDropEvent`; HTML5 drop events
 * never fire for external files. The backend expands directories, filters to
 * supported media, and reads tags on the fly, so dropped files need not be in
 * the library. Resolved tracks carry a natively-playable `file://` path.
 *
 * Returns `isDragging` for a full-window drop-zone overlay.
 */
export function useFileDrop(deps: UseFileDropDeps) {
  const [isDragging, setIsDragging] = useState(false);

  // The listener installs once; keep the latest callbacks in a ref so it never
  // reads stale closures (mirrors useInAppKeyboardShortcuts' deps ref).
  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    async function handleDrop(paths: string[]) {
      const { enqueue, findDuplicates, expandQueue, notify } = depsRef.current;
      try {
        const resolved = await invoke<DroppedTrack[]>("resolve_dropped_paths", { paths });
        if (resolved.length === 0) {
          notify("No playable media found in the dropped files");
          return;
        }
        const tracks: QueueTrack[] = resolved.map((d) => ({
          key: nextExternalKey(),
          path: d.path,
          title: d.title,
          artist_name: d.artist_name,
          album_title: d.album_title,
          duration_secs: d.duration_secs,
          format: d.format,
          liked: 0,
        }));
        // When some are already queued, `enqueue` raises the duplicate banner
        // (its own feedback) instead of appending — so only toast the count when
        // the enqueue will actually append everything now.
        const willAppend = findDuplicates(tracks).duplicates.length === 0;
        enqueue(tracks);
        expandQueue();
        if (willAppend) {
          notify(`Added ${tracks.length} track${tracks.length > 1 ? "s" : ""} to the queue`);
        }
      } catch (e) {
        console.error("Failed to enqueue dropped files:", e);
        notify("Couldn't add the dropped files");
      }
    }

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          // `enter` carries paths; `over` doesn't (position only). Ignore an
          // `enter` with no paths defensively so the overlay only lights up for
          // real file drags; the following `over` events keep it lit.
          if (p.type === "enter" && p.paths.length === 0) return;
          setIsDragging(true);
        } else if (p.type === "leave") {
          setIsDragging(false);
        } else if (p.type === "drop") {
          setIsDragging(false);
          if (p.paths.length > 0) void handleDrop(p.paths);
        }
      })
      .then((fn) => {
        if (disposed) safeUnlisten(fn);
        else unlisten = fn;
      })
      .catch((e) => console.error("Failed to subscribe to file-drop events:", e));

    return () => {
      disposed = true;
      safeUnlisten(unlisten);
    };
  }, []);

  return { isDragging };
}
