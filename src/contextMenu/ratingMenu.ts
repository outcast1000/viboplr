import type { MenuItemSpec } from "../nativeMenu";

/** The three rating choices as native check items: Like / No rating / Dislike.
 *  Shared by the heart's own right-click menu (`LikeDislikeButtons`) and the
 *  now-playing bar's Rating submenu, so both offer the same words.
 *
 *  `like` / `dislike` are the canonical toggles (`useLikeActions`, each backed
 *  by `nextTriState`), which is why every choice maps onto one of them:
 *  Like from disliked is a like (-1 → 1), Dislike from liked a dislike
 *  (1 → -1), and choosing the state already set toggles it off. */
export function buildRatingMenuSpecs(
  rating: number,
  actions: { like: () => void; dislike: () => void },
): MenuItemSpec[] {
  const current = rating === 1 ? 1 : rating === -1 ? -1 : 0;
  return [
    { kind: "check", text: "Like", checked: current === 1, action: actions.like },
    {
      kind: "check",
      text: "No rating",
      checked: current === 0,
      enabled: current !== 0,
      action: () => {
        if (current === 1) actions.like();
        else if (current === -1) actions.dislike();
      },
    },
    { kind: "check", text: "Dislike", checked: current === -1, action: actions.dislike },
  ];
}
