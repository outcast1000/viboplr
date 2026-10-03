/** The mini player's size vocabulary, kept free of Tauri/store imports so pure
 *  modules (the control API's validators in `uiControl.ts`) can use it.
 *  `useMiniMode.ts` re-exports all of it; that hook owns what the sizes mean. */

export type MiniWidthSize = "small" | "medium" | "large";

/** Menu/select order for the width presets, shared by the mini player's
 *  context menu, Settings and the control API. */
export const MINI_WIDTH_SIZES = ["small", "medium", "large"] as const;

export type MiniRestingSize = "normal" | "compact" | "full";

/** Menu/select order for the resting size — shared by the mini player's own
 *  toggle, its context menu, Settings and the control API, so none of them can
 *  disagree about what a size is called. */
export const MINI_RESTING_SIZES = ["normal", "compact", "full"] as const;
