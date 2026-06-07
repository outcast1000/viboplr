import { useState, useRef, useEffect, useCallback } from "react";
import {
  IconHeartFilled,
  IconHeartOutline,
  IconThumbsDownFilled,
} from "./Icons";
import { resolveLikeAction, type LikeState, type LikeTarget } from "../utils/likeControl";

// The three rating choices. Each shows its representative icon regardless of
// current state: filled red heart (like), empty heart (neutral), filled red
// hand (dislike). The popover renders only the choices that aren't selected.
const CHOICES: { target: LikeTarget; Icon: typeof IconHeartFilled; cls: string; label: string }[] = [
  { target: 1, Icon: IconHeartFilled, cls: "liked", label: "Like" },
  { target: 0, Icon: IconHeartOutline, cls: "ds-like-neutral", label: "Clear rating" },
  { target: -1, Icon: IconThumbsDownFilled, cls: "disliked", label: "Dislike" },
];

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

// Per-variant class for the individual choice buttons (reuses existing styling).
const CHOICE_CLASS: Record<string, string> = {
  inline: "ds-like-inline",
  overlay: "ds-like-overlay",
  default: "ds-like-btn",
};

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
  const [expanded, setExpanded] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const current = (liked === 1 ? 1 : liked === -1 ? -1 : 0) as LikeState;
  const hasDislike = !!onToggleDislike;

  // Collapse the tap-expanded state when clicking outside.
  useEffect(() => {
    if (!expanded) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setExpanded(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [expanded]);

  const choiceClass = variant === "glass" ? `g-btn g-btn-${glassSize}` : (CHOICE_CLASS[variant] ?? "ds-like-btn");
  const statusSize = Math.round(size * 1.4);
  const choiceSize = Math.round(size * 1.6);
  const likeLabel = entityLabel ? `${entityLabel} ` : "";

  const apply = useCallback((target: LikeTarget, e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled) return;
    const action = resolveLikeAction(current, target);
    if (action === "like") {
      e.currentTarget.classList.add("anim-heart-bounce");
      onToggleLike();
    } else if (action === "dislike") {
      e.currentTarget.classList.add("anim-heart-bounce-subtle");
      onToggleDislike?.();
    }
    setExpanded(false);
  }, [current, disabled, onToggleLike, onToggleDislike]);

  // Collapsed status icon reflects current state.
  const StatusIcon = current === 1 ? IconHeartFilled : current === -1 ? IconThumbsDownFilled : IconHeartOutline;
  const statusStateClass = current === 1 ? " liked" : current === -1 ? " disliked" : "";
  const statusTitle = current === 1
    ? `Liked ${likeLabel}`.trim()
    : current === -1 ? `Disliked ${likeLabel}`.trim() : `Rate ${likeLabel}`.trim();

  return (
    <div
      ref={wrapRef}
      className={`ds-like-control ds-like-control--${variant}${expanded ? " expanded" : ""}`}
      onMouseLeave={() => setExpanded(false)}
    >
      <button
        type="button"
        className={`${choiceClass} ds-like-status${statusStateClass}`}
        title={statusTitle}
        disabled={disabled}
        onClick={(e) => { e.stopPropagation(); if (!disabled) setExpanded(v => !v); }}
      >
        <StatusIcon size={statusSize} />
      </button>
      <div className="ds-like-choices">
        {CHOICES
          .filter(c => c.target !== current && (c.target !== -1 || hasDislike))
          .map(c => (
            <button
              key={c.target}
              type="button"
              className={`${choiceClass} ${c.cls}`}
              title={`${c.label} ${likeLabel}${c.target === 1 && showKeyboardHint ? ` ${showKeyboardHint}` : ""}`.trim()}
              disabled={disabled}
              onClick={(e) => apply(c.target, e)}
              onAnimationEnd={(e) => e.currentTarget.classList.remove("anim-heart-bounce", "anim-heart-bounce-subtle")}
            >
              <c.Icon size={choiceSize} />
            </button>
          ))}
      </div>
    </div>
  );
}
