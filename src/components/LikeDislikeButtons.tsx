import { useRef, useCallback } from "react";
import {
  IconHeartFilled,
  IconHeartOutline,
  IconThumbsDown,
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
  const likeRef = useRef<HTMLButtonElement>(null);
  const dislikeRef = useRef<HTMLButtonElement>(null);

  const likeLabel = entityLabel ? `${entityLabel} ` : "";
  const likeTitle = liked === 1
    ? `Unlike ${likeLabel}`.trim()
    : `Like ${likeLabel}${showKeyboardHint ? ` ${showKeyboardHint}` : ""}`.trim();
  const dislikeTitle = liked === -1
    ? `Remove ${likeLabel}dislike`.trim()
    : `Dislike ${likeLabel}${showKeyboardHint ? "" : ""}`.trim();

  const handleLikeClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled) return;
    likeRef.current?.classList.add("anim-heart-bounce");
    onToggleLike();
  }, [onToggleLike, disabled]);

  const handleDislikeClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled) return;
    dislikeRef.current?.classList.add("anim-heart-bounce-subtle");
    onToggleDislike?.();
  }, [onToggleDislike, disabled]);

  const clearLikeAnim = useCallback(() => {
    likeRef.current?.classList.remove("anim-heart-bounce");
  }, []);

  const clearDislikeAnim = useCallback(() => {
    dislikeRef.current?.classList.remove("anim-heart-bounce-subtle");
  }, []);

  const LikeIcon = liked === 1 ? IconHeartFilled : IconHeartOutline;
  const DislikeIcon = liked === -1 ? IconThumbsDownFilled : IconThumbsDown;

  if (variant === "glass") {
    return (
      <>
        <button
          ref={likeRef}
          className={`g-btn g-btn-${glassSize}${liked === 1 ? " liked" : ""}`}
          onClick={handleLikeClick}
          onAnimationEnd={clearLikeAnim}
          title={likeTitle}
          disabled={disabled}
        >
          <LikeIcon size={size} />
        </button>
        {onToggleDislike && (
          <button
            ref={dislikeRef}
            className={`g-btn g-btn-${glassSize}${liked === -1 ? " disliked" : ""}`}
            onClick={handleDislikeClick}
            onAnimationEnd={clearDislikeAnim}
            title={dislikeTitle}
            disabled={disabled}
          >
            <DislikeIcon size={size} />
          </button>
        )}
      </>
    );
  }

  if (variant === "overlay") {
    return (
      <div className="ds-like-overlay-group">
        <button
          ref={likeRef}
          className={`ds-like-overlay${liked === 1 ? " liked" : ""}`}
          onClick={handleLikeClick}
          onAnimationEnd={clearLikeAnim}
          title={likeTitle}
          disabled={disabled}
        >
          <LikeIcon size={size} />
        </button>
        {onToggleDislike && (
          <button
            ref={dislikeRef}
            className={`ds-dislike-overlay${liked === -1 ? " disliked" : ""}`}
            onClick={handleDislikeClick}
            onAnimationEnd={clearDislikeAnim}
            title={dislikeTitle}
            disabled={disabled}
          >
            <DislikeIcon size={size} />
          </button>
        )}
      </div>
    );
  }

  if (variant === "inline") {
    return (
      <span className="ds-like-inline-group">
        <button
          ref={likeRef}
          className={`ds-like-inline${liked === 1 ? " liked" : ""}`}
          onClick={handleLikeClick}
          onAnimationEnd={clearLikeAnim}
          title={likeTitle}
          disabled={disabled}
        >
          <LikeIcon size={size} />
        </button>
        {onToggleDislike && (
          <button
            ref={dislikeRef}
            className={`ds-dislike-inline${liked === -1 ? " disliked" : ""}`}
            onClick={handleDislikeClick}
            onAnimationEnd={clearDislikeAnim}
            title={dislikeTitle}
            disabled={disabled}
          >
            <DislikeIcon size={size} />
          </button>
        )}
      </span>
    );
  }

  // variant === "default" — detail pages
  return (
    <>
      <button
        ref={likeRef}
        className={`ds-like-btn${liked === 1 ? " liked" : ""}`}
        onClick={handleLikeClick}
        onAnimationEnd={clearLikeAnim}
        title={likeTitle}
        disabled={disabled}
      >
        <LikeIcon size={size} />
      </button>
      {onToggleDislike && (
        <button
          ref={dislikeRef}
          className={`ds-dislike-btn${liked === -1 ? " disliked" : ""}`}
          onClick={handleDislikeClick}
          onAnimationEnd={clearDislikeAnim}
          title={dislikeTitle}
          disabled={disabled}
        >
          <DislikeIcon size={size} />
        </button>
      )}
    </>
  );
}
