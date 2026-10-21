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
// Managed tools (yt-dlp, slskd, …) are announced here too and installed only on
// the user's click: there is no silent tool updater any more.
//
// Everything here is pure so the ranking and the dismissal rules can be
// asserted without a store, a network or a render.
import type { ExtensionUpdate } from "../types/plugin";

/** What a notice can be about; each part is dismissed on its own. */
export type UpdateNoticeKind = "app" | "extensions" | "tools";

/** A managed tool with an update (`useDependencies.updates`, outdated + Vibo's copy). */
export interface ToolUpdate {
  name: string;
  installed?: string;
  latest: string;
  /** A plugin runs it as a background program: the update stops and restarts it. */
  running?: boolean;
}

/** One line of the "Which ones" list. */
export interface UpdateNoticeItem {
  kind: UpdateNoticeKind;
  name: string;
  from?: string;
  to: string;
  running?: boolean;
}

export interface UpdateNotice {
  /** The single part this notice is about, or `mixed` for several at once. */
  kind: UpdateNoticeKind | "mixed";
  /** The parts it covers, app first. */
  parts: UpdateNoticeKind[];
  /**
   * What each part announces. Dismissal is remembered against these strings,
   * so the release the user waved away stays quiet while the next one
   * announces itself — the banner must not become a thing you dismiss once and
   * never see again.
   */
  signatures: Partial<Record<UpdateNoticeKind, string>>;
  /** Headline sentence. */
  title: string;
  /** App release notes, when the app is in this notice. */
  body?: string;
  /** Names of the extensions with updates. */
  names?: string[];
  /** Everything in this notice, for the "Which ones" list. */
  items: UpdateNoticeItem[];
}

/** Dismissals: notice part → the signature that was dismissed for it. */
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

/** Same rule for tools, by name + latest version: a new yt-dlp nightly is a
 *  new announcement even after the previous one was dismissed. */
export function toolsNoticeSignature(updates: ToolUpdate[]): string {
  return `tools:${updates.map((u) => `${u.name}@${u.latest}`).sort().join(",")}`;
}

export interface UpdateNoticeInput {
  /** `updateState.available` from `useAppUpdater`. */
  appUpdate: { version: string; body: string } | null;
  /** `updates` from `useExtensions` (unfiltered; this module filters). */
  extensionUpdates: ExtensionUpdate[];
  /** Managed tools with an update. */
  toolUpdates?: ToolUpdate[];
  dismissed: UpdateNoticeDismissals;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/**
 * One banner, one line for everything pending (owner decision, 2026-10-20):
 * "6 updates: Vibo, 3 extensions, 2 tools". Each part is included unless its
 * own signature was dismissed, so waving away the app release doesn't silence
 * extensions or tools — they are different errands. A notice with one part
 * reads exactly as that part's notice always has.
 */
export function resolveUpdateNotice(input: UpdateNoticeInput): UpdateNotice | null {
  const { appUpdate, extensionUpdates, toolUpdates = [], dismissed } = input;
  const parts: UpdateNoticeKind[] = [];
  const signatures: Partial<Record<UpdateNoticeKind, string>> = {};
  const items: UpdateNoticeItem[] = [];

  if (appUpdate) {
    const signature = appNoticeSignature(appUpdate.version);
    if (dismissed.app !== signature) {
      parts.push("app");
      signatures.app = signature;
      items.push({ kind: "app", name: "Vibo", to: appUpdate.version });
    }
  }

  const exts = installable(extensionUpdates);
  if (exts.length > 0) {
    const signature = extensionsNoticeSignature(extensionUpdates);
    if (dismissed.extensions !== signature) {
      parts.push("extensions");
      signatures.extensions = signature;
      for (const u of exts) items.push({ kind: "extensions", name: u.name, from: u.currentVersion, to: u.latestVersion });
    }
  }

  if (toolUpdates.length > 0) {
    const signature = toolsNoticeSignature(toolUpdates);
    if (dismissed.tools !== signature) {
      parts.push("tools");
      signatures.tools = signature;
      for (const u of toolUpdates) {
        items.push({ kind: "tools", name: u.name, from: u.installed, to: u.latest, running: u.running });
      }
    }
  }

  if (parts.length === 0) return null;
  const base = {
    parts,
    signatures,
    items,
    body: parts.includes("app") ? appUpdate?.body || undefined : undefined,
    names: parts.includes("extensions") ? exts.map((u) => u.name) : undefined,
  };

  if (parts.length > 1) {
    const labels = parts.map((p) =>
      p === "app" ? "Vibo" : p === "extensions" ? plural(exts.length, "extension", "extensions") : plural(toolUpdates.length, "tool", "tools"),
    );
    return { ...base, kind: "mixed", title: `${items.length} updates: ${labels.join(", ")}` };
  }

  const only = parts[0];
  if (only === "app") return { ...base, kind: "app", title: `Vibo ${appUpdate!.version} is available` };
  if (only === "extensions") {
    return {
      ...base,
      kind: "extensions",
      title: exts.length === 1 ? `An update is available for ${exts[0].name}` : `${exts.length} extension updates are available`,
    };
  }
  return {
    ...base,
    kind: "tools",
    title:
      toolUpdates.length === 1
        ? `An update is available for ${toolUpdates[0].name}`
        : `${toolUpdates.length} tool updates are available`,
  };
}

/** "yt-dlp 2026.10.10 → 2026.10.19 · running, restarts after the update". */
export function noticeItemLine(item: UpdateNoticeItem): string {
  const version = item.from ? `${item.from} → ${item.to}` : item.to;
  return `${item.name} ${version}${item.running ? " · running, restarts after the update" : ""}`;
}

/**
 * The order "Update all" installs in: tools, then extensions, then the app —
 * the app's update relaunches Vibo, so anything after it would be lost.
 */
export function updateAllOrder(notice: UpdateNotice): UpdateNoticeKind[] {
  return (["tools", "extensions", "app"] as const).filter((k) => notice.parts.includes(k));
}

/**
 * Record a dismissal of every part the notice covers. Returns the previous
 * object identity when nothing changes, so the persist effect behind this
 * state doesn't write the store on a repeat.
 */
export function dismissNotice(
  dismissed: UpdateNoticeDismissals,
  notice: UpdateNotice,
): UpdateNoticeDismissals {
  let next = dismissed;
  for (const part of notice.parts) {
    const signature = notice.signatures[part];
    if (!signature || next[part] === signature) continue;
    next = { ...next, [part]: signature };
  }
  return next;
}
