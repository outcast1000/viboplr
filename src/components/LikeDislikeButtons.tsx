import { useCallback, useEffect, useRef } from "react";
import {
  IconHeartFilled,
  IconHeartOutline,
  IconBan,
} from "./Icons";
import { useTrackLike } from "../contexts/TrackLikeContext";
import { showNativeMenu } from "../nativeMenu";
import { buildRatingMenuSpecs } from "../contextMenu/ratingMenu";

interface LikeDislikeButtonsProps {
  /** The state for an artist / album / tag heart. For a track heart (`track`
   *  given) it is only the fallback until the store has loaded, and may be
   *  omitted — a queue entry has no `liked` of its own. */
  liked?: number;
  /** A track's identity. When given, the shown state comes from the track-like
   *  store (one answer per song, whichever copy this is). Omit it for artists,
   *  albums, tags. */
  track?: { title: string; artist_name?: string | null } | null;
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

// One heart. A click is a plain like toggle — never a dislike, because a dislike
// keeps the song out of radio and the mixes, and the commonest correction (taking
// a like back) must not land there:
//   neutral (0) ⇄ like (1)        click
//   dislike (-1) → neutral (0)    click (the ban icon reads as "undo")
// Dislike is deliberate: right-click the heart for Like / No rating / Dislike
// (a native menu, only when `onToggleDislike` is given), or Cmd/Ctrl+Shift+L
// for the playing song. Every choice goes through the existing onToggleLike /
// onToggleDislike callbacks (each backed by nextTriState).
export function LikeDislikeButtons({
  liked: likedProp,
  track,
  onToggleLike,
  onToggleDislike,
  size = 14,
  variant = "default",
  glassSize = "sm",
  entityLabel,
  showKeyboardHint,
  disabled,
}: LikeDislikeButtonsProps) {
  const fromStore = useTrackLike(track ?? null, likedProp);
  const liked = track ? fromStore : likedProp ?? 0;
  const current = liked === 1 ? 1 : liked === -1 ? -1 : 0;
  const hasDislike = !!onToggleDislike;

  const btnClass = variant === "glass" ? `g-btn g-btn-${glassSize}` : (VARIANT_CLASS[variant] ?? "ds-like-btn");
  const iconSize = Math.round(size * 1.4);
  const labelSuffix = entityLabel ? ` ${entityLabel}` : "";

  // Bounce is driven by the rating *changing*, not by the click — so a like from
  // any source (mouse, Cmd+L, context menu, same-song propagation to this copy)
  // animates the visible heart identically. Full bounce when landing on "liked",
  // a subtler one for dislike / clear. Skips the initial mount (prev === current).
  const btnRef = useRef<HTMLButtonElement>(null);
  const prevCurrentRef = useRef(current);
  useEffect(() => {
    if (prevCurrentRef.current === current) return;
    prevCurrentRef.current = current;
    const el = btnRef.current;
    if (!el) return;
    const cls = current === 1 ? "anim-heart-bounce" : "anim-heart-bounce-subtle";
    el.classList.remove("anim-heart-bounce", "anim-heart-bounce-subtle");
    void el.offsetWidth; // restart the animation even if a class lingered
    el.classList.add(cls);
  }, [current]);

  const onClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled) return;
    // Neutral → like, like → neutral (both onToggleLike); dislike → neutral
    // (onToggleDislike toggles it off). The bounce is the effect above.
    if (current === -1 && onToggleDislike) onToggleDislike();
    else onToggleLike();
  }, [current, disabled, onToggleLike, onToggleDislike]);

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    // Without a dislike there is nothing beyond the click; let the surface's
    // own menu (row, bar) answer the right-click.
    if (!hasDislike || disabled) return;
    e.preventDefault();
    e.stopPropagation();
    showNativeMenu(e.clientX, e.clientY, buildRatingMenuSpecs(current, {
      like: onToggleLike,
      dislike: () => onToggleDislike?.(),
    })).catch((err) => console.error("Failed to show the rating menu:", err));
  }, [current, hasDislike, disabled, onToggleLike, onToggleDislike]);

  const Icon = current === 1 ? IconHeartFilled : current === -1 ? IconBan : IconHeartOutline;
  const stateClass = current === 1 ? " liked" : current === -1 ? " disliked" : "";
  // First line: the state (and the like shortcut where it applies). Second line:
  // what a click does next, and where the rest lives.
  const hint = showKeyboardHint ? ` ${showKeyboardHint}` : "";
  const title = current === 1
    ? `Liked${labelSuffix}${hint}\nClick to remove${hasDislike ? " · right-click for more" : ""}`
    : current === -1
      ? `Disliked${labelSuffix}\nKept out of radio and mixes · click to clear`
      : `Like${labelSuffix}${hint}${hasDislike ? "\nRight-click to dislike" : ""}`;

  return (
    <div className={`ds-like-control ds-like-control--${variant}`}>
      <button
        ref={btnRef}
        type="button"
        className={`${btnClass} ds-like-status${stateClass}`}
        title={title}
        aria-label={current === 1 ? `Liked${labelSuffix}` : current === -1 ? `Disliked${labelSuffix}` : `Like${labelSuffix}`}
        aria-pressed={current === 1}
        disabled={disabled}
        onClick={onClick}
        onContextMenu={onContextMenu}
        onAnimationEnd={(e) => e.currentTarget.classList.remove("anim-heart-bounce", "anim-heart-bounce-subtle")}
      >
        <Icon size={iconSize} />
      </button>
    </div>
  );
}
