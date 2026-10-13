import { invoke } from "@tauri-apps/api/core";
import { store, type AppStore } from "../store";

// The Home view's cached shelves live in `{profile}/home-snapshot.json`
// (backend `home_snapshot.rs`), not in the app store. They used to be the
// store key below and grew to ~90% of app-state.json — playlist cards ship
// their whole track list — while the store rewrites that entire file on every
// debounced save. The key is read to migrate it, then deleted.
//
// The read is on the startup path, so it does no more than it must: the file
// and the legacy key are fetched in parallel, the file arrives as raw bytes
// and is parsed once here, and migration / cleanup run in the background
// rather than before Home can paint.
export const LEGACY_SNAPSHOT_KEY = "homeSnapshot";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface HomeSnapshotDeps {
  invoke: Invoke;
  store: Pick<AppStore, "get" | "delete">;
}

const defaultDeps: HomeSnapshotDeps = { invoke, store };

// Writes go through one chain so they land in the order they were made: a
// refresh's final persist and the plugin prune can be issued back to back.
let writeChain: Promise<void> = Promise.resolve();

export function writeHomeSnapshot<T>(snapshot: T, deps: HomeSnapshotDeps = defaultDeps): Promise<void> {
  const next = writeChain.then(() => deps.invoke<void>("home_snapshot_write", { snapshot }));
  // The chain must survive a failed write; the caller gets `next` and logs it.
  writeChain = next.catch(() => {}); // eslint-disable-line no-restricted-syntax -- Fire-and-forget: the caller logs the same rejection via `next`.
  return next;
}

// The migration / cleanup started by the last read, for tests to await.
let background: Promise<void> = Promise.resolve();
export function homeSnapshotBackgroundWork(): Promise<void> {
  return background;
}

type FileRead<T> = { kind: "ok"; value: T } | { kind: "missing" } | { kind: "error" };

const decoder = new TextDecoder();

// "missing" means the file is confirmed absent or unusable (unparseable), so
// the legacy copy may replace it. "error" means we couldn't look — the file
// may well be newer than the legacy copy, so nothing may be written over it.
async function readFile<T>(deps: HomeSnapshotDeps): Promise<FileRead<T>> {
  let raw: ArrayBuffer | null | undefined;
  try {
    raw = await deps.invoke<ArrayBuffer | null>("home_snapshot_read");
  } catch (e) {
    console.error("Failed to read home snapshot file:", e);
    return { kind: "error" };
  }
  if (!raw || raw.byteLength === 0) return { kind: "missing" };
  try {
    const value = JSON.parse(decoder.decode(raw)) as T | null;
    return value ? { kind: "ok", value } : { kind: "missing" };
  } catch (e) {
    console.error("Ignoring unreadable home snapshot file:", e);
    return { kind: "missing" };
  }
}

async function readLegacy<T>(deps: HomeSnapshotDeps): Promise<T | null> {
  try {
    return (await deps.store.get<T>(LEGACY_SNAPSHOT_KEY)) ?? null;
  } catch (e) {
    console.error("Failed to read legacy home snapshot key:", e);
    return null;
  }
}

function dropLegacyKey(deps: HomeSnapshotDeps): Promise<void> {
  return deps.store.delete(LEGACY_SNAPSHOT_KEY).then(() => undefined);
}

// The stored snapshot, or null.
//  - File present: use it. A legacy key still beside it (a delete that failed
//    or never flushed after a migration) is dropped, else it would stay in
//    app-state.json for good.
//  - File missing: a profile that predates it still has the snapshot under the
//    store key — use that and carry it over, dropping the key only once the
//    file holds it, so a failed migration is retried next launch.
//  - File unreadable: use the legacy copy if any, but write nothing.
export async function readHomeSnapshot<T>(deps: HomeSnapshotDeps = defaultDeps): Promise<T | null> {
  const [file, legacy] = await Promise.all([readFile<T>(deps), readLegacy<T>(deps)]);
  if (file.kind === "ok") {
    if (legacy != null) {
      background = dropLegacyKey(deps).catch((e) => console.error("Failed to drop legacy home snapshot key:", e));
    }
    return file.value;
  }
  if (legacy == null) return null;
  if (file.kind === "missing") {
    background = writeHomeSnapshot(legacy, deps)
      .then(() => dropLegacyKey(deps))
      .catch((e) => console.error("Failed to migrate home snapshot out of the store:", e));
  }
  return legacy;
}
