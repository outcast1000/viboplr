import type {
  PluginMenuItem,
  PluginSearchProvider,
  PluginSidebarItem,
  PluginTargetKind,
} from "../types/plugin";

/**
 * Per-contribution on/off for plugins.
 *
 * Disabling a whole plugin is a blunt instrument: a user who wants a plugin's
 * stream resolver but not the four context-menu items it also adds had no way
 * to say so. Providers (information types, images, stream/download) and Home
 * shelves already have per-item control — Settings → Providers and Home →
 * Shelves respectively. This module covers the two contribution kinds that
 * didn't: context-menu items and sidebar views.
 *
 * State is one flat `Record<key, boolean>` persisted under the
 * `pluginContributionVisibility` store key. **A missing key means visible**, so
 * a plugin update that adds a menu item shows it rather than hiding it — the
 * same default-on rule `homeShelfVisibility` uses.
 *
 * The filter is applied once, in `usePlugins`, so every surface that consumes
 * `plugins.menuItems` / `plugins.sidebarItems` / `plugins.searchProviders`
 * inherits it — including native menus built by `buildContextMenuSpecs`, which
 * have no DOM to filter later.
 */

export type PluginContributionKind = "menu" | "sidebar" | "search";

/** `contributionKey(...)` -> enabled. Absent key = enabled. */
export type ContributionVisibility = Record<string, boolean>;

/** One toggleable contribution, as rendered by the Extensions detail pane. */
export interface PluginContribution {
  key: string;
  pluginId: string;
  kind: PluginContributionKind;
  id: string;
  /** What the user sees in the menu / sidebar. */
  label: string;
  /** One line of "where this shows up", shown under the label. */
  detail: string;
}

export function contributionKey(
  pluginId: string,
  kind: PluginContributionKind,
  id: string,
): string {
  return `${pluginId}:${kind}:${id}`;
}

export function isContributionEnabled(
  visibility: ContributionVisibility | undefined,
  pluginId: string,
  kind: PluginContributionKind,
  id: string,
): boolean {
  return visibility?.[contributionKey(pluginId, kind, id)] !== false;
}

/**
 * Drop the contributions the user turned off. Returns the input array
 * unchanged when nothing of this kind is disabled, so the common case adds no
 * allocation and keeps the reference stable for downstream memos.
 *
 * Pass `idOf` for a contribution type that doesn't name its id `id` —
 * `PluginSearchProvider` calls it `providerId`.
 */
export function filterContributions<T extends { pluginId: string; id: string }>(
  items: T[],
  kind: PluginContributionKind,
  visibility: ContributionVisibility | undefined,
): T[];
export function filterContributions<T extends { pluginId: string }>(
  items: T[],
  kind: PluginContributionKind,
  visibility: ContributionVisibility | undefined,
  idOf: (item: T) => string,
): T[];
export function filterContributions<T extends { pluginId: string }>(
  items: T[],
  kind: PluginContributionKind,
  visibility: ContributionVisibility | undefined,
  idOf?: (item: T) => string,
): T[] {
  if (!visibility) return items;
  const id = idOf ?? ((item: T) => (item as unknown as { id: string }).id);
  const enabled = (i: T) =>
    isContributionEnabled(visibility, i.pluginId, kind, id(i));
  if (items.every(enabled)) return items;
  return items.filter(enabled);
}

const TARGET_LABELS: Record<PluginTargetKind, string> = {
  track: "tracks",
  album: "albums",
  artist: "artists",
  "multi-track": "track selections",
  playlist: "playlists",
};

/** "Right-click menu on tracks and albums" — the row's explanatory line. */
export function describeMenuTargets(
  targets: PluginTargetKind[] | undefined,
): string {
  const named: string[] = [];
  for (const t of targets ?? []) {
    const label = TARGET_LABELS[t];
    if (label && !named.includes(label)) named.push(label);
  }
  if (named.length === 0) return "Right-click menu item";
  return `Right-click menu on ${joinList(named)}`;
}

function joinList(parts: string[]): string {
  if (parts.length <= 2) return parts.join(" and ");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export interface PluginContributionSources {
  menuItems: PluginMenuItem[];
  sidebarItems: PluginSidebarItem[];
  searchProviders: PluginSearchProvider[];
}

/**
 * Flatten every toggleable contribution into config rows. Takes the
 * **unfiltered** lists — a contribution the user turned off still needs its row
 * so they can turn it back on. Named rather than positional because three
 * same-typed arrays are trivially swappable at a call site, and a swap would
 * mislabel every row rather than fail.
 *
 * Ordered by how prominent the surface is: the sidebar view, then the search
 * catalog, then menu items by label (usually the longest group).
 */
export function listPluginContributions({
  menuItems,
  sidebarItems,
  searchProviders,
}: PluginContributionSources): PluginContribution[] {
  const sidebar = [...sidebarItems]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((s) => ({
      key: contributionKey(s.pluginId, "sidebar", s.id),
      pluginId: s.pluginId,
      kind: "sidebar" as const,
      id: s.id,
      label: s.label,
      detail: "Sidebar view",
    }));

  const search = [...searchProviders]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({
      key: contributionKey(p.pluginId, "search", p.providerId),
      pluginId: p.pluginId,
      kind: "search" as const,
      id: p.providerId,
      label: p.name,
      detail: "Global search (Cmd+K)",
    }));

  const menu = [...menuItems]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((m) => ({
      key: contributionKey(m.pluginId, "menu", m.id),
      pluginId: m.pluginId,
      kind: "menu" as const,
      id: m.id,
      // Submenu items read as orphaned fragments on their own ("MP3", "FLAC"),
      // so carry the parent label the native menu would have grouped them under.
      label: m.submenuLabel ? `${m.submenuLabel} → ${m.label}` : m.label,
      detail: describeMenuTargets(m.targets),
    }));

  return [...sidebar, ...search, ...menu];
}
