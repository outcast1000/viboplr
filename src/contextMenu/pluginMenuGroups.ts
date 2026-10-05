// Pure helpers for turning plugin context-menu items into renderable shapes.
// `layoutPluginMenu` decides the structure once and every surface renders that
// tree: the native right-click menus (buildPluginMenuSpecs) and the detail-page
// overflow menu (heroOverflow). The goal is one row per plugin, not one per
// action, so the menu stays short however many plugins are installed:
//
// - An action label offered by several plugins ("Play the Full Album" from
//   Last.fm and Spotify) becomes one submenu named after the action, with one
//   entry per plugin.
// - A plugin left with two or more entries gets one submenu named after the
//   plugin, holding its bare labels and its own `submenuLabel` groups.
// - A plugin left with a single entry stays flat, labelled "Plugin: Label".
// - A `submenuLabel` group shared by several plugins (a common "Search") stays
//   a top-level submenu whose entries name their plugin.
//
// The top level is sorted alphabetically, so a row keeps its position as other
// plugins are installed or removed.
import type { MenuItemSpec } from "../nativeMenu";
import type { PluginMenuItem, PluginContextMenuTarget } from "../types/plugin";

/**
 * Prefix a label with the plugin that owns it ("Last.fm: Play the Full Album"),
 * so a plugin action is never mistaken for a built-in one. Never doubles a
 * name: a label that already names the plugin (an older plugin build's
 * "Upgrade with qBittorrent…") is kept as is, and a label the plugin name
 * already contains (Web Search's "Search" submenu) collapses to the name.
 */
export function withPluginName(label: string, pluginName: string | undefined): string {
  if (!pluginName) return label;
  const l = label.toLowerCase();
  const n = pluginName.toLowerCase();
  if (l.includes(n)) return label;
  if (n.includes(l)) return pluginName;
  return `${pluginName}: ${label}`;
}

/** Display label for a flat (ungrouped) plugin menu item. */
export function pluginMenuItemLabel(item: PluginMenuItem): string {
  return withPluginName(item.label, item.pluginName);
}

/** A laid-out plugin menu: leaves dispatch `item`, submenus nest. */
export type PluginMenuNode =
  | { kind: "leaf"; text: string; item: PluginMenuItem }
  | { kind: "submenu"; key: string; text: string; children: PluginMenuNode[] };

const byOrderThenLabel = (a: PluginMenuItem, b: PluginMenuItem) =>
  (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label);
const byText = (a: PluginMenuNode, b: PluginMenuNode) =>
  a.text.localeCompare(b.text, undefined, { sensitivity: "base" });
const labelKey = (label: string) => label.trim().toLowerCase();
const pluginCount = (items: PluginMenuItem[]) => new Set(items.map((it) => it.pluginId)).size;

/** Group `items` by `keyOf`, keeping first-seen order. */
function groupBy<T>(items: T[], keyOf: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = keyOf(it);
    const arr = out.get(k);
    if (arr) arr.push(it); else out.set(k, [it]);
  }
  return out;
}

export function layoutPluginMenu(matching: PluginMenuItem[]): PluginMenuNode[] {
  const flat = matching.filter((it) => !it.submenuLabel);
  const top: PluginMenuNode[] = [];

  // The same action from several plugins → one submenu named after the action.
  const shared = new Set<string>();
  for (const [key, items] of groupBy(flat, (it) => labelKey(it.label))) {
    if (pluginCount(items) < 2) continue;
    shared.add(key);
    top.push({
      kind: "submenu",
      key: `action:${key}`,
      text: items[0].label,
      children: items
        .map((it): PluginMenuNode => ({ kind: "leaf", text: it.pluginName ?? it.pluginId, item: it }))
        .sort(byText),
    });
  }

  // A submenuLabel group spanning several plugins stays top level, leaves named.
  const ownGroups: PluginMenuItem[] = [];
  for (const [label, items] of groupBy(matching.filter((it) => it.submenuLabel), (it) => it.submenuLabel!)) {
    if (pluginCount(items) < 2) { ownGroups.push(...items); continue; }
    top.push({
      kind: "submenu",
      key: `group:${label}`,
      text: label,
      children: [...items].sort(byOrderThenLabel)
        .map((it) => ({ kind: "leaf", text: pluginMenuItemLabel(it), item: it })),
    });
  }

  // Everything left belongs to exactly one plugin.
  const rest = [...flat.filter((it) => !shared.has(labelKey(it.label))), ...ownGroups];
  for (const [pluginId, items] of groupBy(rest, (it) => it.pluginId)) {
    const entries: PluginMenuNode[] = items
      .filter((it) => !it.submenuLabel)
      .map((it) => ({ kind: "leaf", text: it.label, item: it }));
    for (const [label, sub] of groupBy(items.filter((it) => it.submenuLabel), (it) => it.submenuLabel!)) {
      entries.push({
        kind: "submenu",
        key: `group:${pluginId}:${label}`,
        text: label,
        children: [...sub].sort(byOrderThenLabel).map((it) => ({ kind: "leaf", text: it.label, item: it })),
      });
    }
    const name = items[0].pluginName;
    if (entries.length === 1) {
      top.push({ ...entries[0], text: withPluginName(entries[0].text, name) });
    } else {
      top.push({ kind: "submenu", key: `plugin:${pluginId}`, text: name ?? pluginId, children: entries });
    }
  }

  return top.sort(byText);
}

/** Native context-menu specs for the plugin items matching one target. */
export function buildPluginMenuSpecs(
  matching: PluginMenuItem[],
  target: PluginContextMenuTarget,
  dispatch: (pluginId: string, actionId: string, t: PluginContextMenuTarget) => void,
): MenuItemSpec[] {
  const toSpec = (node: PluginMenuNode): MenuItemSpec =>
    node.kind === "leaf"
      ? { kind: "item", text: node.text, action: () => dispatch(node.item.pluginId, node.item.id, target) }
      : { kind: "submenu", text: node.text, items: node.children.map(toSpec) };
  return layoutPluginMenu(matching).map(toSpec);
}
