/** Tri-state like value: -1 dislike, 0 neutral, 1 like. */
export type LikeState = -1 | 0 | 1;
/** A choice the user can pick in the expanded control. */
export type LikeTarget = -1 | 0 | 1;

/**
 * Map a chosen target state onto the existing toggle callbacks, given the
 * current state. Returns which toggle to fire, or null if already in `target`.
 * - "like"    → call onToggleLike()    (flips 0/-1 → 1, or 1 → 0 for neutral)
 * - "dislike" → call onToggleDislike() (flips 0/1 → -1, or -1 → 0 for neutral)
 */
export function resolveLikeAction(current: LikeState, target: LikeTarget): "like" | "dislike" | null {
  if (current === target) return null;
  if (target === 1) return "like";
  if (target === -1) return "dislike";
  // target === 0 (neutral): re-toggle whichever is currently active back to 0
  return current === 1 ? "like" : "dislike";
}
