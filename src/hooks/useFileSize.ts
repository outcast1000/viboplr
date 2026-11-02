import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

// Sizes looked up this session, by path (`null` = unknown). One lookup per path
// however many rows show it; in-flight lookups are shared. Rows subscribe, so a
// forget makes the visible ones show the new answer.
const sizes = new Map<string, number | null>();
const pending = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
// What a lookup's answer is valid for: a forget-all bumps the epoch, a forget
// of one path bumps that path's generation. A lookup whose stamp moved while
// it ran answers for the old file, so it asks again instead of being stored.
let epoch = 0;
const pathGen = new Map<string, number>();

function stamp(path: string): string {
  return `${epoch}:${pathGen.get(path) ?? 0}`;
}

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function start(path: string): void {
  const token = stamp(path);
  const p: Promise<void> = invoke<number | null>("queue_entry_file_size", { path })
    .then((size) => (typeof size === "number" ? size : null))
    .catch((e) => {
      console.error("Failed to look up file size:", e);
      return null;
    })
    .then((size) => {
      // Only the newest lookup for a path owns its entry.
      if (pending.get(path) !== p) return;
      pending.delete(path);
      if (stamp(path) !== token) {
        // Forgotten while in flight: the rows waiting on it still want an
        // answer, and this one may describe the old file.
        start(path);
        return;
      }
      sizes.set(path, size);
      notify();
    });
  pending.set(path, p);
}

function lookupFileSize(path: string): void {
  if (sizes.has(path) || pending.has(path)) return;
  start(path);
}

/** Forget what this session looked up — every path, or just these (a file
 *  replaced in place keeps its path). Rows on screen look their size up
 *  again; a lookup already in flight re-asks when it lands. */
export function forgetFileSizes(paths?: Iterable<string>): void {
  if (paths) {
    for (const p of paths) {
      pathGen.set(p, (pathGen.get(p) ?? 0) + 1);
      sizes.delete(p);
    }
  } else {
    epoch++;
    sizes.clear();
    pathGen.clear();
  }
  notify();
}

/**
 * The size a queue row shows, looked up once the row is on screen (`enabled`).
 * Queue entries carry no size of their own: the backend answers from the
 * library row (by path, through an index — Subsonic included), then from
 * the file on disk for a local file the library doesn't hold. A path-less
 * entry (metadata only) has nothing to look up.
 */
export function useFileSize(path: string | null | undefined, enabled: boolean): number | null {
  const wanted = path && enabled ? path : null;
  const size = useSyncExternalStore(subscribe, () => (wanted ? sizes.get(wanted) ?? null : null));
  const known = useSyncExternalStore(subscribe, () => (wanted ? sizes.has(wanted) : true));

  useEffect(() => {
    if (wanted && !known) lookupFileSize(wanted);
  }, [wanted, known]);

  return size;
}
