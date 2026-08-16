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

export interface HeroButton {
  id: string;
  label: string;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  onClick: () => void;
}

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
  // The hero's own action buttons, replacing the fixed Play/Enqueue pair. For a
  // subject those two verbs don't fit — see the render.
  buttons?: HeroButton[];

  // Title + Back only: no artwork, no background, no motion look, no FX picker.
  // For a hero whose subject HAS no image — the point of the hero there is the
  // identity and the back button, and a 320px scrimmed panel wrapped around a
  // placeholder disc is chrome standing in for content.
  plain?: boolean;

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
  buttons,
  plain,
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
    plain ? "detail-hero--plain" : "",
    // A motion look animates the background; with no background it would only
    // add a class nothing reads.
    !plain && look ? `hero-motion-${look.motion}` : "",
    !plain && look?.layers.bw ? "hero-bw" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={heroClass}>
      {!plain && <DetailHeroBackground images={bgImages} className={bgClassName ?? "detail-hero-bg"} />}
      {!plain && <DetailHeroEffect look={look} />}
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
      {/* The FX picker chooses a background effect; with no background it would
          be a control over nothing. */}
      {!plain && (
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
      )}
      <div className="detail-hero-row">
        {/* No art block at all when plain — not an empty one. A subject with no
            image of its own (a torrent) would otherwise get a placeholder disc
            in the most prominent part of the header, which is chrome standing
            in for content. */}
        {!plain && (
          <div className={`detail-hero-art detail-hero-art--${artShape}`}>
            {art}
          </div>
        )}
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
            {/* `buttons` REPLACES the Play/Enqueue pair rather than joining it:
                a subject those two verbs don't apply to (a torrent — you start
                and stop it) would otherwise carry two permanently disabled
                buttons next to its real ones. Its own actions then sit exactly
                where every other detail page puts its primary controls. */}
            {buttons ? (
              buttons.map((b) => (
                <button
                  key={b.id}
                  className={`ds-btn ds-btn--${b.variant ?? "secondary"}`}
                  onClick={b.onClick}
                  disabled={b.disabled}
                >
                  {b.label}
                </button>
              ))
            ) : (
              <>
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
              </>
            )}
            <HeroOverflowMenu items={overflowItems} />
          </div>
          {titleLine && <div className="detail-hero-titleline">{titleLine}</div>}
        </div>
      </div>
    </div>
  );
}
