// Pure helpers for turning plugin context-menu items into renderable shapes.
// Items that share a `submenuLabel` are grouped into one submenu (sorted by
// `order` then label); ungrouped items stay flat. The grouping is shared by the
// native right-click menu (buildContextMenuSpecs) and the detail-page overflow
// menu (heroOverflow) so both render plugin items identically.
import type { MenuItemSpec } from "../nativeMenu";
import type { PluginMenuItem, PluginContextMenuTarget } from "../types/plugin";

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
    specs.push({ kind: "item", text: item.label, action: () => dispatch(item.pluginId, item.id, target) });
  }
  for (const [label, items] of groups) {
    specs.push({
      kind: "submenu",
      text: label,
      items: items.map((it) => ({
        kind: "item" as const,
        text: it.label,
        action: () => dispatch(it.pluginId, it.id, target),
      })),
    });
  }
  return specs;
}
