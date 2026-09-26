// Pure helpers for turning plugin context-menu items into renderable shapes.
// Items that share a `submenuLabel` are grouped into one submenu (sorted by
// `order` then label); ungrouped items stay flat. The grouping is shared by the
// native right-click menu (buildContextMenuSpecs) and the detail-page overflow
// menu (heroOverflow) so both render plugin items identically.
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

/**
 * Labels for a submenu group. When every leaf comes from one plugin the name
 * goes on the submenu itself (leaves stay short, e.g. "MP3" / "FLAC"); a group
 * shared by several plugins names each leaf instead.
 */
export function pluginSubmenuLabels(
  label: string,
  items: PluginMenuItem[],
): { submenu: string; leaf: (item: PluginMenuItem) => string } {
  const names = new Set(items.map((it) => it.pluginName));
  if (names.size === 1) {
    return { submenu: withPluginName(label, items[0]?.pluginName), leaf: (it) => it.label };
  }
  return { submenu: label, leaf: pluginMenuItemLabel };
}

/** Split items into flat (no submenuLabel) + sorted submenu groups. */
export function groupBySubmenuLabel(matching: PluginMenuItem[]): {
  flat: PluginMenuItem[];
  groups: Array<[string, PluginMenuItem[]]>;
} {
  const groups = new Map<string, PluginMenuItem[]>();
  const flat: PluginMenuItem[] = [];
  for (const item of matching) {
    if (item.submenuLabel) {
      const arr = groups.get(item.submenuLabel) ?? [];
      arr.push(item);
      groups.set(item.submenuLabel, arr);
    } else {
      flat.push(item);
    }
  }
  const sortedGroups: Array<[string, PluginMenuItem[]]> = [...groups.entries()].map(
    ([label, items]) => [
      label,
      [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label)),
    ],
  );
  return { flat, groups: sortedGroups };
}

/** Native context-menu specs: flat items first, then one submenu per group. */
export function buildPluginMenuSpecs(
  matching: PluginMenuItem[],
  target: PluginContextMenuTarget,
  dispatch: (pluginId: string, actionId: string, t: PluginContextMenuTarget) => void,
): MenuItemSpec[] {
  if (matching.length === 0) return [];
  const { flat, groups } = groupBySubmenuLabel(matching);
  const specs: MenuItemSpec[] = [];
  for (const item of flat) {
    specs.push({ kind: "item", text: pluginMenuItemLabel(item), action: () => dispatch(item.pluginId, item.id, target) });
  }
  for (const [label, items] of groups) {
    const labels = pluginSubmenuLabels(label, items);
    specs.push({
      kind: "submenu",
      text: labels.submenu,
      items: items.map((it) => ({
        kind: "item" as const,
        text: labels.leaf(it),
        action: () => dispatch(it.pluginId, it.id, target),
      })),
    });
  }
  return specs;
}
