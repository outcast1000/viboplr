// `restore` rules for the persisted settings whose saved value needs more than
// the default same-shape check (usePersistedSetting → `sameShape`). Each takes
// the raw stored value and returns the setting's value, or undefined to keep
// the default. Pinned by `__tests__/persistedSettingHydration.test.ts`.
import type { ViewMode } from "../types";
import { QUEUE_LIMITS, SIDEBAR_LIMITS, restorePaneWidth } from "../utils/paneResize";

export type SearchViewModes = { tracks: ViewMode; albums: ViewMode; artists: ViewMode; tags: ViewMode };

const VIEW_MODES: readonly unknown[] = ["basic", "list", "tiles"];
const isViewMode = (v: unknown): v is ViewMode => VIEW_MODES.includes(v);

export const restoreQueueWidth = restorePaneWidth(QUEUE_LIMITS);
export const restoreSidebarWidth = restorePaneWidth(SIDEBAR_LIMITS);

/** All of tracks/albums/artists must be valid; `tags` was added later and
 *  falls back to tiles. */
export function restoreSearchViewModes(raw: unknown): SearchViewModes | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Partial<Record<keyof SearchViewModes, unknown>>;
  if (!isViewMode(s.tracks) || !isViewMode(s.albums) || !isViewMode(s.artists)) return undefined;
  return { tracks: s.tracks, albums: s.albums, artists: s.artists, tags: isViewMode(s.tags) ? s.tags : "tiles" };
}

export function restoreOneOf<T extends string>(allowed: readonly T[]): (raw: unknown) => T | undefined {
  return (raw) => (allowed as readonly unknown[]).includes(raw) ? (raw as T) : undefined;
}

export function restoreNonEmptyString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw ? raw : undefined;
}

export function restoreStringList(raw: unknown): string[] | undefined {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : undefined;
}
