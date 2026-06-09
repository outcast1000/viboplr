import { useCallback } from "react";
import {
  IconHeartFilled,
  IconHeartOutline,
  IconThumbsDownFilled,
} from "./Icons";

interface LikeDislikeButtonsProps {
  liked: number;
  onToggleLike: () => void;
  onToggleDislike?: () => void;
  size?: number;
  variant?: "default" | "glass" | "overlay" | "inline";
  glassSize?: "sm" | "xs";
  entityLabel?: string;
  showKeyboardHint?: string;
  disabled?: boolean;
}

// Per-variant class for the single button (reuses existing styling).
const VARIANT_CLASS: Record<string, string> = {
  inline: "ds-like-inline",
  overlay: "ds-like-overlay",
  default: "ds-like-btn",
};

// A single button that cycles the rating on each click:
//   neutral (0) → like (1) → dislike (-1) → neutral (0)
// It reuses the existing onToggleLike / onToggleDislike callbacks (each backed
// by nextTriState) by picking which one advances from the current state.
// If onToggleDislike is omitted the button degrades to a plain like toggle
// (0 → 1 → 0) via onToggleLike.
export function LikeDislikeButtons({
  liked,
  onToggleLike,
  onToggleDislike,
  size = 14,
  variant = "default",
  glassSize = "sm",
  entityLabel,
  showKeyboardHint,
  disabled,
}: LikeDislikeButtonsProps) {
  const current = liked === 1 ? 1 : liked === -1 ? -1 : 0;
  const hasDislike = !!onToggleDislike;

  const btnClass = variant === "glass" ? `g-btn g-btn-${glassSize}` : (VARIANT_CLASS[variant] ?? "ds-like-btn");
  const iconSize = Math.round(size * 1.4);
  const labelSuffix = entityLabel ? ` ${entityLabel}` : "";

  const onClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled) return;
    // From neutral, advance to like. From like, advance to dislike (or back to
    // neutral when there's no dislike callback). From dislike, back to neutral.
    if (current === 0) {
      e.currentTarget.classList.add("anim-heart-bounce");
      onToggleLike();
    } else if (current === 1) {
      if (hasDislike) {
        e.currentTarget.classList.add("anim-heart-bounce-subtle");
        onToggleDislike?.();
      } else {
        e.currentTarget.classList.add("anim-heart-bounce");
        onToggleLike();
      }
    } else {
      e.currentTarget.classList.add("anim-heart-bounce-subtle");
      onToggleDislike?.();
    }
  }, [current, hasDislike, disabled, onToggleLike, onToggleDislike]);

  const Icon = current === 1 ? IconHeartFilled : current === -1 ? IconThumbsDownFilled : IconHeartOutline;
  const stateClass = current === 1 ? " liked" : current === -1 ? " disliked" : "";
  const title = (
    current === 1 ? `Liked${labelSuffix}`
      : current === -1 ? `Disliked${labelSuffix}`
        : `Rate${labelSuffix}`
  ) + (showKeyboardHint ? ` ${showKeyboardHint}` : "");

  return (
    <div className={`ds-like-control ds-like-control--${variant}`}>
      <button
        type="button"
        className={`${btnClass} ds-like-status${stateClass}`}
        title={title.trim()}
        disabled={disabled}
        onClick={onClick}
        onAnimationEnd={(e) => e.currentTarget.classList.remove("anim-heart-bounce", "anim-heart-bounce-subtle")}
      >
        <Icon size={iconSize} />
      </button>
    </div>
  );
}
