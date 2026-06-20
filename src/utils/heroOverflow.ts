import type { PluginMenuItem, PluginContextMenuTarget } from "../types/plugin";
import { groupBySubmenuLabel } from "../contextMenu/pluginMenuGroups";

export type HeroOverflowItem =
  | { kind: "action"; id: string; label: string; onClick: () => void; iconKey?: string; danger?: boolean }
  | { kind: "submenu"; id: string; label: string; items: Array<{ id: string; label: string; onClick: () => void }> }
  | { kind: "divider" };

export interface HeroImageActions {
  onRefresh?: () => void;            // "Retrieve image" — re-fetch via provider chain
  onSetFromFile?: () => void;        // "Set image…" — open file picker
  onPasteFromClipboard?: () => void; // "Paste image"
  onRemove?: () => void;             // "Remove image" — only when an image exists
  onSearchImage?: () => void;        // "Search image" — Google Images
}

export interface HeroYoutubeActions {
  onFind: () => void;                // "Find in YouTube" — search + open
}

export interface HeroRadioActions {
  onStart: () => void;               // "Start radio" — build a station from this track
}

export interface HeroOverflowArgs {
  entityKind: "track" | "album" | "artist" | "tag";
  imageActions: HeroImageActions;
  radio?: HeroRadioActions;           // honored only when entityKind === "track"
  youtube?: HeroYoutubeActions;       // honored only when entityKind === "track"
  pluginItems: HeroOverflowItem[];
}

export function buildHeroOverflowItems(args: HeroOverflowArgs): HeroOverflowItem[] {
  const out: HeroOverflowItem[] = [];

  // Image actions (in display order)
  const ia = args.imageActions;
  if (ia.onRefresh)            out.push({ kind: "action", id: "image-refresh",       label: "Retrieve image", onClick: ia.onRefresh,            iconKey: "refresh" });
  if (ia.onSetFromFile)        out.push({ kind: "action", id: "image-set",           label: "Set image…", onClick: ia.onSetFromFile,        iconKey: "image" });
  if (ia.onPasteFromClipboard) out.push({ kind: "action", id: "image-paste",         label: "Paste image",    onClick: ia.onPasteFromClipboard, iconKey: "paste" });
  if (ia.onRemove)             out.push({ kind: "action", id: "image-remove",        label: "Remove image",   onClick: ia.onRemove,             iconKey: "remove", danger: true });
  if (ia.onSearchImage)        out.push({ kind: "action", id: "image-search",        label: "Search image",   onClick: ia.onSearchImage,        iconKey: "google" });

  // Track-only playback/external actions (radio + YouTube), grouped together.
  if (args.entityKind === "track") {
    const trackActions: HeroOverflowItem[] = [];
    if (args.radio)   trackActions.push({ kind: "action", id: "start-radio",  label: "Start radio",      onClick: args.radio.onStart, iconKey: "radio" });
    if (args.youtube) trackActions.push({ kind: "action", id: "youtube-find", label: "Find in YouTube",  onClick: args.youtube.onFind, iconKey: "youtube" });
    if (trackActions.length > 0) {
      if (out.length > 0) out.push({ kind: "divider" });
      out.push(...trackActions);
    }
  }

  // Plugin items
  if (args.pluginItems.length > 0) {
    if (out.length > 0) out.push({ kind: "divider" });
    out.push(...args.pluginItems);
  }

  return out;
}

/**
 * Build detail-page overflow items from a plugin's context-menu items for an
 * entity. Mirrors the native menu grouping (flat items, then one submenu per
 * `submenuLabel`); each leaf dispatches to the owning plugin. This is what lets
 * plugin-registered actions (e.g. the search-providers "Search" submenu) appear
 * in the detail-page ⋯ menu, not just the right-click menu.
 */
export function buildPluginOverflowItems(
  matching: PluginMenuItem[],
  target: PluginContextMenuTarget,
  dispatch: (pluginId: string, actionId: string, t: PluginContextMenuTarget) => void,
): HeroOverflowItem[] {
  if (matching.length === 0) return [];
  const { flat, groups } = groupBySubmenuLabel(matching);
  const out: HeroOverflowItem[] = [];
  for (const item of flat) {
    out.push({
      kind: "action",
      id: `${item.pluginId}:${item.id}`,
      label: item.label,
      onClick: () => dispatch(item.pluginId, item.id, target),
    });
  }
  for (const [label, items] of groups) {
    out.push({
      kind: "submenu",
      id: `submenu:${label}`,
      label,
      items: items.map((it) => ({
        id: `${it.pluginId}:${it.id}`,
        label: it.label,
        onClick: () => dispatch(it.pluginId, it.id, target),
      })),
    });
  }
  return out;
}
