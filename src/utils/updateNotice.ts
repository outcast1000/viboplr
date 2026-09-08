// Which "something can be updated" notice the content banner announces.
//
// Before this, an available release was announced ONLY as a small dot on the
// sidebar's Settings button, and installing it meant knowing to open
// Settings → General and press a button there. Settings is a destination
// nobody visits unprompted — the same reasoning that gave Collections its
// sync-error dot — so for a user who never opens it the release they were
// being "notified" about was in practice invisible, and the release notes the
// updater already fetches were rendered nowhere at all.
//
// Everything here is pure so the ranking and the dismissal rules can be
// asserted without a store, a network or a render.
import type { ExtensionUpdate } from "../types/plugin";

export type UpdateNoticeKind = "app" | "extensions";

export interface UpdateNotice {
  kind: UpdateNoticeKind;
  /**
   * Identifies *what* is being announced. Dismissal is remembered against this
   * string, so the release the user waved away stays quiet while the next one
   * announces itself — the banner must not become a thing you dismiss once and
   * never see again.
   */
  signature: string;
  /** Headline sentence. */
  title: string;
  /** Release notes for the "What's new" expander. App updates only. */
  body?: string;
  /** Names of the extensions with updates, for the extensions notice. */
  names?: string[];
}

/** Dismissals: notice kind → the signature that was dismissed for it. */
export type UpdateNoticeDismissals = Partial<Record<UpdateNoticeKind, string>>;

/** Only `available` updates count. `requires_app_update` is blocked behind the
 *  app notice, so announcing it would offer an action that cannot succeed —
 *  the same filter `useExtensions.updateCount` applies to the sidebar badge. */
function installable(updates: ExtensionUpdate[]): ExtensionUpdate[] {
  return updates.filter((u) => u.status === "available");
}

export function appNoticeSignature(version: string): string {
  return `app:${version}`;
}

/**
 * Keyed by the exact set of pending updates rather than by a count: dismissing
 * "2 extension updates" must not also silence a third that appears tomorrow,
 * and a count-based key would collide with exactly that case. Sorted so the
 * signature doesn't depend on the order the backend happened to report.
 */
export function extensionsNoticeSignature(updates: ExtensionUpdate[]): string {
  const ids = installable(updates)
    .map((u) => `${u.id}@${u.latestVersion}`)
    .sort();
  return `ext:${ids.join(",")}`;
}

export interface UpdateNoticeInput {
  /** `updateState.available` from `useAppUpdater`. */
  appUpdate: { version: string; body: string } | null;
  /** `updates` from `useExtensions` (unfiltered; this module filters). */
  extensionUpdates: ExtensionUpdate[];
  dismissed: UpdateNoticeDismissals;
}

/**
 * One banner at a time, app update first.
 *
 * The app outranks extensions for two reasons: an extension update may be
 * *gated* on it (`requires_app_update`), and two stacked banners would push the
 * view down twice for one errand. A dismissed app notice falls through to the
 * extensions one rather than silencing it — they are different errands.
 */
export function resolveUpdateNotice(input: UpdateNoticeInput): UpdateNotice | null {
  const { appUpdate, extensionUpdates, dismissed } = input;

  if (appUpdate) {
    const signature = appNoticeSignature(appUpdate.version);
    if (dismissed.app !== signature) {
      return {
        kind: "app",
        signature,
        title: `Viboplr ${appUpdate.version} is available`,
        body: appUpdate.body || undefined,
      };
    }
  }

  const exts = installable(extensionUpdates);
  if (exts.length > 0) {
    const signature = extensionsNoticeSignature(extensionUpdates);
    if (dismissed.extensions !== signature) {
      return {
        kind: "extensions",
        signature,
        title:
          exts.length === 1
            ? `An update is available for ${exts[0].name}`
            : `${exts.length} extension updates are available`,
        names: exts.map((u) => u.name),
      };
    }
  }

  return null;
}

/**
 * Record a dismissal. Returns the previous object identity when the signature
 * was already dismissed, so the persist effect behind this state doesn't write
 * the store on a repeat.
 */
export function dismissNotice(
  dismissed: UpdateNoticeDismissals,
  notice: UpdateNotice,
): UpdateNoticeDismissals {
  if (dismissed[notice.kind] === notice.signature) return dismissed;
  return { ...dismissed, [notice.kind]: notice.signature };
}
