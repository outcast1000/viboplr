import type { ReactNode } from "react";
import { DetailHeroBackground } from "./DetailHeroBackground";
import { HeroOverflowMenu } from "./HeroOverflowMenu";
import { LikeDislikeButtons } from "./LikeDislikeButtons";
import type { HeroOverflowItem } from "../utils/heroOverflow";
import { useRef } from "react";
import { DetailHeroEffect } from "./DetailHeroEffect";
import { useHeroEffectMode } from "../heroEffectMode";
import {
  resolveHeroLook,
  getLook,
  EFFECT_MODE_OPTIONS,
  type HeroEffectMode,
} from "../heroLooks";
import "./DetailHero.css";

export interface DetailHeroChip {
  label: string;
  onClick?: () => void;
}

interface DetailHeroProps {
  bgImages: string[];
  bgClassName?: string;

  onBack?: () => void;

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

  // Optional one-line description shown under the meta chips (e.g. featured artists).
  description?: string;

  onPlay?: () => void;
  onEnqueue?: () => void;
  playDisabled?: boolean;
  enqueueDisabled?: boolean;

  overflowItems: HeroOverflowItem[];

  titleLine?: ReactNode;
}

export function DetailHero({
  bgImages, bgClassName,
  onBack,
  art, artShape,
  eyebrow, title,
  liked, onToggleLike, onToggleDislike, likeDisabled, entityLabel,
  meta,
  description,
  onPlay, onEnqueue, playDisabled, enqueueDisabled,
  overflowItems,
  titleLine,
}: DetailHeroProps) {
  const showLike = liked !== undefined && (onToggleLike || likeDisabled);
  const [effectMode, setEffectMode] = useHeroEffectMode();
  // One random roll per mount, so "Random" stays stable while on this page and
  // re-rolls when the hero is navigated away and back. Ignored for other modes.
  const rollRef = useRef(Math.random());
  const lookId = resolveHeroLook(effectMode, title, rollRef.current);
  const look = lookId ? getLook(lookId) : null;
  const heroClass = [
    "detail-hero",
    look ? `hero-motion-${look.motion}` : "",
    look?.layers.bw ? "hero-bw" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={heroClass}>
      <DetailHeroBackground images={bgImages} className={bgClassName ?? "detail-hero-bg"} />
      <DetailHeroEffect look={look} />
      {onBack && (
        <button
          className="detail-hero-back"
          onClick={onBack}
          aria-label="Back"
          title="Back"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
      )}
      <select
        className="detail-hero-fx-select"
        value={effectMode}
        onChange={(e) => setEffectMode(e.target.value as HeroEffectMode)}
        aria-label="Hero background effect"
        title="Hero background effect"
      >
        {EFFECT_MODE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
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
          {description && <div className="detail-hero-description">{description}</div>}
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
