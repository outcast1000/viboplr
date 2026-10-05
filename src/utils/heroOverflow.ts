import type { PluginMenuItem, PluginContextMenuTarget } from "../types/plugin";
import { layoutPluginMenu, type PluginMenuNode } from "../contextMenu/pluginMenuGroups";

/** A submenu entry: an action, or a nested submenu (plugin menus nest). */
export type HeroOverflowSubItem =
  | { id: string; label: string; onClick: () => void }
  | { id: string; label: string; items: HeroOverflowSubItem[] };

export type HeroOverflowItem =
  | { kind: "action"; id: string; label: string; onClick: () => void; iconKey?: string; danger?: boolean }
  | { kind: "submenu"; id: string; label: string; items: HeroOverflowSubItem[] }
  | { kind: "divider" };

export interface HeroImageActions {
  onRefresh?: () => void;            // "Retrieve image" — re-fetch via provider chain
  onSetFromFile?: () => void;        // "Set image…" — open file picker
  onPasteFromClipboard?: () => void; // "Paste image"
  onRemove?: () => void;             // "Remove image" — only when an image exists
  onSearchImage?: () => void;        // "Search image" — Google Images
}

export interface HeroRadioActions {
  onStart: () => void;               // "Start radio" — build a station from this track
}

export interface HeroOverflowArgs {
  entityKind: "track" | "album" | "artist" | "tag" | "playlist";
  imageActions: HeroImageActions;
  radio?: HeroRadioActions;           // honored only when entityKind === "track"
  enqueue?: () => void;               // "Enqueue" — first, on pages whose hero shows Radio instead
  pluginItems: HeroOverflowItem[];
}

export function buildHeroOverflowItems(args: HeroOverflowArgs): HeroOverflowItem[] {
  const out: HeroOverflowItem[] = [];

  // Enqueue leads, in its own group: on the entity pages it moved here from the
  // hero to make room for Radio, and it is the item reached for most.
  const lead: HeroOverflowItem[] = [];
  if (args.enqueue) lead.push({ kind: "action", id: "enqueue", label: "Enqueue", onClick: args.enqueue, iconKey: "enqueue" });

  // Image actions (in display order)
  const ia = args.imageActions;
  if (ia.onRefresh)            out.push({ kind: "action", id: "image-refresh",       label: "Retrieve image", onClick: ia.onRefresh,            iconKey: "refresh" });
  if (ia.onSetFromFile)        out.push({ kind: "action", id: "image-set",           label: "Set image…", onClick: ia.onSetFromFile,        iconKey: "image" });
  if (ia.onPasteFromClipboard) out.push({ kind: "action", id: "image-paste",         label: "Paste image",    onClick: ia.onPasteFromClipboard, iconKey: "paste" });
  if (ia.onRemove)             out.push({ kind: "action", id: "image-remove",        label: "Remove image",   onClick: ia.onRemove,             iconKey: "remove", danger: true });
  if (ia.onSearchImage)        out.push({ kind: "action", id: "image-search",        label: "Search image",   onClick: ia.onSearchImage,        iconKey: "google" });

  // Track-only playback/external actions (radio), grouped together.
  if (args.entityKind === "track") {
    const trackActions: HeroOverflowItem[] = [];
    if (args.radio) trackActions.push({ kind: "action", id: "start-radio", label: "Start radio", onClick: args.radio.onStart, iconKey: "radio" });
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

  if (lead.length === 0) return out;
  return out.length > 0 ? [...lead, { kind: "divider" }, ...out] : lead;
}

/**
 * Build detail-page overflow items from the plugin context-menu items for an
 * entity, laid out exactly like the native right-click menu
 * (`layoutPluginMenu`); each leaf dispatches to the owning plugin. This is what
 * lets plugin-registered actions (e.g. the search-providers "Search" submenu)
 * appear in the detail-page ⋯ menu, not just the right-click menu.
 */
export function buildPluginOverflowItems(
  matching: PluginMenuItem[],
  target: PluginContextMenuTarget,
  dispatch: (pluginId: string, actionId: string, t: PluginContextMenuTarget) => void,
): HeroOverflowItem[] {
  const toSub = (node: PluginMenuNode): HeroOverflowSubItem =>
    node.kind === "leaf"
      ? { id: `${node.item.pluginId}:${node.item.id}`, label: node.text, onClick: () => dispatch(node.item.pluginId, node.item.id, target) }
      : { id: `submenu:${node.key}`, label: node.text, items: node.children.map(toSub) };
  return layoutPluginMenu(matching).map((node): HeroOverflowItem => {
    const sub = toSub(node);
    return "items" in sub
      ? { kind: "submenu", id: sub.id, label: sub.label, items: sub.items }
      : { kind: "action", id: sub.id, label: sub.label, onClick: sub.onClick };
  });
}
