import type { PluginSearchProvider, PluginTrack } from "../types/plugin";

/**
 * What the global search knows about one plugin provider for the *current*
 * query. Every provider starts `idle` — the host does not query plugin catalogs
 * while the user types (see `PluginSearchAPI`), so `idle` means "offered, not
 * asked yet", and the whole map resets when the query changes.
 */
export type ProviderRunState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; tracks: PluginTrack[] }
  | { status: "empty" }
  | { status: "error"; message?: string };

/** `pluginId:providerId` — the key both the state map and the handler map use. */
export function providerKeyOf(p: { pluginId: string; providerId: string }): string {
  return `${p.pluginId}:${p.providerId}`;
}

/**
 * A row the dropdown renders inside a provider's section. `itemIndex` is the
 * row's position in the dropdown's flat `items` array, or null when the row is
 * display-only — the arrow keys walk `items`, so a null here is what keeps the
 * highlight from landing on a spinner or an error message.
 */
export interface PluginSearchRow {
  key: string;
  providerKey: string;
  kind: "run" | "loading" | "empty" | "error" | "track";
  track?: PluginTrack;
  message?: string;
  itemIndex: number | null;
}

export interface PluginSearchSection {
  providerKey: string;
  name: string;
  icon?: string;
  rows: PluginSearchRow[];
}

/** The selectable rows, in display order, ready to append to `items`. */
export type PluginSearchSelectable =
  | { kind: "plugin-run"; providerKey: string; name: string }
  | { kind: "plugin-track"; providerKey: string; track: PluginTrack };

/**
 * Lay out the plugin half of the dropdown: one section per provider, and the
 * flat list of selectable rows that the keyboard navigates.
 *
 * `baseIndex` is how many library items precede these, since plugin sections
 * always render last. Returning both halves from one pass is deliberate — the
 * rendered rows and the keyboard's `items` array cannot disagree about an index
 * if the same walk produces both.
 */
export function buildPluginSearchSections(
  providers: PluginSearchProvider[],
  states: Record<string, ProviderRunState>,
  baseIndex: number,
): { sections: PluginSearchSection[]; selectable: PluginSearchSelectable[] } {
  const sections: PluginSearchSection[] = [];
  const selectable: PluginSearchSelectable[] = [];
  let next = baseIndex;

  for (const provider of providers) {
    const key = providerKeyOf(provider);
    const state = states[key] ?? { status: "idle" };
    const rows: PluginSearchRow[] = [];

    switch (state.status) {
      case "idle":
        rows.push({ key: `${key}:run`, providerKey: key, kind: "run", itemIndex: next++ });
        selectable.push({ kind: "plugin-run", providerKey: key, name: provider.name });
        break;
      case "loading":
        rows.push({ key: `${key}:loading`, providerKey: key, kind: "loading", itemIndex: null });
        break;
      case "empty":
        rows.push({ key: `${key}:empty`, providerKey: key, kind: "empty", itemIndex: null });
        break;
      case "error":
        rows.push({
          key: `${key}:error`,
          providerKey: key,
          kind: "error",
          message: state.message,
          itemIndex: null,
        });
        break;
      case "done":
        // A provider that answered with nothing is `empty`, so `done` always has
        // rows; the guard keeps a misbehaving provider from rendering a section
        // with no content and no explanation.
        if (state.tracks.length === 0) {
          rows.push({ key: `${key}:empty`, providerKey: key, kind: "empty", itemIndex: null });
          break;
        }
        state.tracks.forEach((track, i) => {
          rows.push({
            key: `${key}:track:${i}`,
            providerKey: key,
            kind: "track",
            track,
            itemIndex: next++,
          });
          selectable.push({ kind: "plugin-track", providerKey: key, track });
        });
        break;
    }

    sections.push({ providerKey: key, name: provider.name, icon: provider.icon, rows });
  }

  return { sections, selectable };
}
