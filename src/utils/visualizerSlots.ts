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
 * Native menu for picking a slot's visualizer — a check list with an explicit
 * "None" at the top. Native, per the app-wide rule that every menu is an OS
 * menu; returns specs so the item set is assertable without a DOM.
 */
export function buildVisualizerMenuSpecs(
  visualizers: PluginVisualizerRegistration[],
  selection: VisualizerSlotSelection,
  placement: PluginVisualizerPlacement,
  onPick: (key: string | null) => void,
): MenuItemSpec[] {
  const candidates = candidatesFor(visualizers, placement);
  const current = resolveSlot(visualizers, selection, placement);

  if (candidates.length === 0) {
    return [
      { kind: "item", text: "No visualizers installed", enabled: false, action: () => {} },
    ];
  }

  const specs: MenuItemSpec[] = [
    { kind: "check", text: "None", checked: current === null, action: () => onPick(null) },
    { kind: "separator" },
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
  return specs;
}
