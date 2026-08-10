import type { Collection } from "../types";

/**
 * Sidebar label for a collection that failed to sync, or null when none did.
 *
 * `last_sync_error` was previously rendered only inside CollectionsView, which
 * is a bottom-of-sidebar destination with no reason to visit. So a server going
 * down was discoverable only by playback failing — the error naming the actual
 * cause sat one click away on a page nobody had been given a reason to open.
 *
 * Disabled collections are skipped: they aren't syncing, so a stale error on one
 * is history rather than news, and a dot that can't be cleared by fixing
 * anything is just noise.
 */
export function collectionAlert(collections: Collection[]): string | null {
  const failed = collections.filter((c) => c.enabled && c.last_sync_error);
  if (failed.length === 0) return null;
  if (failed.length === 1) return `${failed[0].name} couldn't sync`;
  return `${failed.length} collections couldn't sync`;
}
