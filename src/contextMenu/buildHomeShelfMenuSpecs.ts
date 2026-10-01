import type { MenuItemSpec } from "../nativeMenu";

export interface HomeShelfMenuDeps {
  /** Position of the shelf among the shelves on screen (0 = the hero carousel). */
  index: number;
  /** How many shelves are on screen. */
  count: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onHide: () => void;
  onCustomize: () => void;
}

/**
 * The ⋯ native menu on a Home shelf header (and on the hero carousel, which is
 * just the first shelf). Pure so the items behind a native menu — which has no
 * DOM — stay assertable; `HomeView` owns the anchor and `showNativeMenu`.
 *
 * Move up / down step past the neighbouring shelf *on screen*, not the next id
 * in the saved order: hidden and empty shelves sit in that order too, and
 * stepping past one of those would make the action look like it did nothing.
 */
export function buildHomeShelfMenuSpecs(deps: HomeShelfMenuDeps): MenuItemSpec[] {
  const { index, count } = deps;
  return [
    { kind: "item", text: "Move up", enabled: index > 0, action: deps.onMoveUp },
    { kind: "item", text: "Move down", enabled: index < count - 1, action: deps.onMoveDown },
    { kind: "separator" },
    { kind: "item", text: "Hide this shelf", action: deps.onHide },
    { kind: "separator" },
    { kind: "item", text: "Customize Home…", action: deps.onCustomize },
  ];
}
