// Which visualizer fills which slot. Pure, so the rules are assertable without
// mounting anything.

import type {
  PluginVisualizerPlacement,
  PluginVisualizerRegistration,
} from "../types/pluginVisualizer";
import type { MenuItemSpec } from "../nativeMenu";

/** Persisted as `visualizerSlots` in the app store. */
export type VisualizerSlotSelection = Partial<Record<PluginVisualizerPlacement, string | null>>;

/** Stable key for a registration: `pluginId:visualizerId`. */
export function visualizerKey(v: PluginVisualizerRegistration): string {
  return `${v.pluginId}:${v.id}`;
}

/** Split a persisted key back into its parts, or null if malformed. */
export function parseVisualizerKey(
  key: string | null | undefined,
): { pluginId: string; visualizerId: string } | null {
  if (!key) return null;
  const sep = key.indexOf(":");
  // A visualizer id may itself contain ":" — split on the FIRST separator only,
  // since the plugin id never does.
  if (sep <= 0 || sep === key.length - 1) return null;
  return { pluginId: key.slice(0, sep), visualizerId: key.slice(sep + 1) };
}

/** Visualizers willing to fill this slot. */
export function candidatesFor(
  visualizers: PluginVisualizerRegistration[],
  placement: PluginVisualizerPlacement,
): PluginVisualizerRegistration[] {
  return visualizers.filter((v) => v.placements?.includes(placement));
}

/**
 * Resolve what a slot should actually render.
 *
 * Returns null when the selection names a visualizer that isn't available —
 * its plugin was disabled, uninstalled, or dropped the contribution in an
 * update. The slot then renders as empty rather than erroring: a stale
 * selection is a normal state, not a fault, and the user's choice is left in
 * the store so it comes back if they re-enable the plugin.
 */
export function resolveSlot(
  visualizers: PluginVisualizerRegistration[],
  selection: VisualizerSlotSelection,
  placement: PluginVisualizerPlacement,
): string | null {
  const key = selection[placement];
  if (!key) return null;
  const available = candidatesFor(visualizers, placement).some((v) => visualizerKey(v) === key);
  return available ? key : null;
}

/**
 * Resolve the `fullscreen` slot, falling back to the Now Playing pick.
 *
 * Going fullscreen from the Now Playing view means "show me this, bigger" —
 * so the slot inherits whatever is already on screen, provided that visualizer
 * declares it can fill it. Treating fullscreen as a second, separately-chosen
 * visualizer would leave the obvious gesture doing nothing until the user found
 * a setting they had no reason to look for.
 *
 * An explicit `fullscreen` selection still wins, so the key keeps its meaning
 * for a visualizer that is only worth showing at full size. Nothing sets it
 * today — it is honoured, not offered.
 */
export function resolveFullscreenSlot(
  visualizers: PluginVisualizerRegistration[],
  selection: VisualizerSlotSelection,
): string | null {
  const explicit = resolveSlot(visualizers, selection, "fullscreen");
  if (explicit) return explicit;
  const nowPlaying = resolveSlot(visualizers, selection, "nowplaying");
  if (!nowPlaying) return null;
  const willing = candidatesFor(visualizers, "fullscreen").some(
    (v) => visualizerKey(v) === nowPlaying,
  );
  return willing ? nowPlaying : null;
}

/**
 * The built-in choice: fill the slot with the track's own artwork.
 *
 * This used to be presented as **"None"**, which described the mechanism and
 * misdescribed the result — an unselected slot has never rendered nothing, it
 * renders the image-provider chain's answer for the track (explicit `image_url`
 * → album image → artist image → the letter placeholder). So "None" told the user
 * their choice was an absence when it was in fact the default visual, and made a
 * freshly-installed plugin look like the only thing on the list that *did*
 * anything.
 *
 * It is still persisted as `null`, deliberately. Giving it a key would mean
 * migrating every stored `visualizerSlots` and teaching `resolveSlot` /
 * `VisualizerSlot` about a visualizer with no plugin and no factory behind it —
 * all to store a different spelling of the same state. The rename is a
 * presentation change, and stays one.
 */
export const ARTWORK_VISUALIZER_NAME = "Artwork";

/**
 * Native menu for picking a slot's visualizer — a check list of every option,
 * artwork included. Native, per the app-wide rule that every menu is an OS menu;
 * returns specs so the item set is assertable without a DOM.
 *
 * Artwork leads the list as a peer of the plugins rather than sitting above a
 * separator, because it is one: picking it is a choice about what fills the slot,
 * not a refusal to choose.
 */
export function buildVisualizerMenuSpecs(
  visualizers: PluginVisualizerRegistration[],
  selection: VisualizerSlotSelection,
  placement: PluginVisualizerPlacement,
  onPick: (key: string | null) => void,
): MenuItemSpec[] {
  const candidates = candidatesFor(visualizers, placement);
  const current = resolveSlot(visualizers, selection, placement);

  // Checked whenever no plugin visualizer is live — which includes a *stale*
  // selection (plugin disabled or uninstalled), since that is what the slot is
  // actually showing. The list never names something that isn't on screen.
  const specs: MenuItemSpec[] = [
    {
      kind: "check",
      text: ARTWORK_VISUALIZER_NAME,
      checked: current === null,
      action: () => onPick(null),
    },
  ];

  for (const v of candidates) {
    const key = visualizerKey(v);
    specs.push({
      kind: "check",
      text: v.name,
      checked: current === key,
      action: () => onPick(key),
    });
  }

  // Nothing installed: keep the hint that was the whole value of the old empty
  // state, but below a real checked entry instead of replacing one. The picker
  // previously showed *only* this line, so it couldn't say what was on screen.
  if (candidates.length === 0) {
    specs.push(
      { kind: "separator" },
      {
        kind: "item",
        text: "No visualizer plugins installed",
        enabled: false,
        action: () => {},
      },
    );
  }

  return specs;
}
