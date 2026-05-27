import type { ReactNode } from "react";
import { DetailHeroBackground } from "./DetailHeroBackground";
import { HeroOverflowMenu } from "./HeroOverflowMenu";
import { LikeDislikeButtons } from "./LikeDislikeButtons";
import type { HeroOverflowItem } from "../utils/heroOverflow";
import "./DetailHero.css";

export interface DetailHeroChip {
  label: string;
  onClick?: () => void;
}

interface DetailHeroProps {
  bgImages: string[];
  bgClassName?: string;

  art: ReactNode;
  artShape: "square" | "circle";

  eyebrow?: string;
  title: string;

  // Like/dislike: pass `liked` only when the entity supports it; pass undefined to hide.
  liked?: number;
  onToggleLike?: () => void;
  onToggleDislike?: () => void;
  likeDisabled?: boolean;
  entityLabel: "track" | "album" | "artist" | "tag";

  meta: Array<string | DetailHeroChip>;

  onPlay?: () => void;
  onEnqueue?: () => void;
  playDisabled?: boolean;
  enqueueDisabled?: boolean;

  overflowItems: HeroOverflowItem[];

  titleLine?: ReactNode;
}

export function DetailHero({
  bgImages, bgClassName,
  art, artShape,
  eyebrow, title,
  liked, onToggleLike, onToggleDislike, likeDisabled, entityLabel,
  meta,
  onPlay, onEnqueue, playDisabled, enqueueDisabled,
  overflowItems,
  titleLine,
}: DetailHeroProps) {
  const showLike = liked !== undefined && (onToggleLike || likeDisabled);

  return (
    <div className="detail-hero">
      <DetailHeroBackground images={bgImages} className={bgClassName ?? "detail-hero-bg"} />
      <div className="detail-hero-row">
        <div className={`detail-hero-art detail-hero-art--${artShape}`}>
          {art}
        </div>
        <div className="detail-hero-info">
          {eyebrow && <div className="detail-hero-eyebrow">{eyebrow}</div>}
          <h2 className="detail-hero-title">
            <span className="detail-hero-title-text">{title}</span>
            {showLike && (
              <LikeDislikeButtons
                liked={liked ?? 0}
                onToggleLike={onToggleLike ?? (() => {})}
                onToggleDislike={onToggleDislike ?? (() => {})}
                size={16}
                variant="glass"
                entityLabel={entityLabel}
                disabled={likeDisabled}
              />
            )}
          </h2>
          {meta.length > 0 && (
            <div className="detail-hero-meta-row">
              {meta.map((m, i) => {
                const chip = typeof m === "string" ? { label: m } : m;
                const className = `detail-hero-chip${chip.onClick ? " detail-hero-chip--clickable" : ""}`;
                return (
                  <span
                    key={`${chip.label}-${i}`}
                    className={className}
                    onClick={chip.onClick}
                  >
                    {chip.label}
                  </span>
                );
              })}
            </div>
          )}
          <div className="detail-hero-actions">
            <button
              className="ds-btn ds-btn--primary"
              onClick={onPlay}
              disabled={playDisabled || !onPlay}
            >
              <span aria-hidden>▶</span> Play
            </button>
            <button
              className="ds-btn ds-btn--secondary"
              onClick={onEnqueue}
              disabled={enqueueDisabled || !onEnqueue}
            >
              <span aria-hidden>≡+</span> Enqueue
            </button>
            <HeroOverflowMenu items={overflowItems} />
          </div>
          {titleLine && <div className="detail-hero-titleline">{titleLine}</div>}
        </div>
      </div>
    </div>
  );
}
