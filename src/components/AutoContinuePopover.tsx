import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AutoContinueWeights } from "../hooks/useAutoContinue";
import { HelpLink } from "./HelpLink";
import "./AutoContinuePopover.css";

/** Gap between the anchor button and the panel's bottom edge. */
const ANCHOR_GAP_PX = 8;

const SLIDERS: { key: keyof AutoContinueWeights; label: string }[] = [
  { key: "random", label: "Random" },
  { key: "sameArtist", label: "Same Artist" },
  { key: "sameTag", label: "Same Tag" },
  { key: "mostPlayed", label: "Most Played" },
  { key: "liked", label: "Liked" },
];

interface Props {
  enabled: boolean;
  sameFormat: boolean;
  weights: AutoContinueWeights;
  onToggle: () => void;
  onToggleSameFormat: () => void;
  onAdjust: (key: keyof AutoContinueWeights, value: number) => void;
  onResetAll: () => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

export function AutoContinuePopover({
  enabled, sameFormat, weights,
  onToggle, onToggleSameFormat, onAdjust, onResetAll,
  onClose, anchorRef,
}: Props) {
  const popoverRef = useRef<HTMLDivElement>(null);
  // Viewport coordinates, because the panel is portalled out of the bar — see
  // the portal note below. Bottom/right, so it grows up and to the left off the
  // button exactly as the old `bottom: calc(100% + 8px); right: 0` did.
  const [pos, setPos] = useState<{ bottom: number; right: number } | null>(null);

  const place = useCallback(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({
      bottom: window.innerHeight - rect.top + ANCHOR_GAP_PX,
      right: window.innerWidth - rect.right,
    });
  }, [anchorRef]);

  useLayoutEffect(() => { place(); }, [place]);

  useEffect(() => {
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [place]);

  useEffect(() => {
    function handleDown(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // Match any popover or anchor in the DOM, since this component may be
      // mounted twice (NowPlayingBar + FullscreenControls share state).
      if (target.closest(".auto-continue-popover")) return;
      if (target.closest(".auto-continue-wrapper")) return;
      onClose();
    }
    document.addEventListener("mousedown", handleDown);
    return () => document.removeEventListener("mousedown", handleDown);
  }, [onClose, anchorRef]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Portalled to `document.fullscreenElement ?? document.body`, same reasoning
  // as `EqPopover`: a z-index only ranks within the nearest stacking context, so
  // in audio fullscreen (`.audio-fs`, z-index 999) this panel was capped below
  // the queue drawer (fixed, 1000 at the root) and opened underneath it. The
  // fullscreen half of the target keeps it visible over browser-engine
  // `:fullscreen` video, which paints only its own subtree.
  return createPortal(
    <div
      className="auto-continue-popover"
      ref={popoverRef}
      role="dialog"
      aria-label="Auto Continue"
      style={pos ? { bottom: pos.bottom, right: pos.right } : { visibility: "hidden" }}
    >
      <div className="ac-titlebar">
        <span className="ac-title">Auto Continue<HelpLink anchor="auto-continue" topic="Auto Continue" /></span>
        <button className="ac-close" onClick={onClose} aria-label="Close" title="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <div className="ac-toolbar">
        <label className="ac-pill-toggle">
          <input type="checkbox" checked={enabled} onChange={onToggle} />
          <span className="ac-toggle-track" aria-hidden="true"><span className="ac-toggle-thumb" /></span>
          <span className="ac-toggle-text">Enable Auto Continue</span>
        </label>
        <div className="ac-toolbar-spacer" />
        <label className="ac-pill-toggle">
          <input type="checkbox" checked={sameFormat} onChange={onToggleSameFormat} />
          <span className="ac-toggle-track" aria-hidden="true"><span className="ac-toggle-thumb" /></span>
          <span className="ac-toggle-text">Same format</span>
        </label>
        <button className="ac-icon-btn" onClick={onResetAll} title="Reset all weights" aria-label="Reset all weights">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 10 9 10"/></svg>
        </button>
      </div>

      <div className="ac-sliders">
        {SLIDERS.map(({ key, label }) => (
          <div className="ac-slider-row" key={key}>
            <span className="ac-slider-label">{label}</span>
            <input
              className="ac-slider"
              type="range"
              min={0}
              max={100}
              value={weights[key]}
              onChange={e => onAdjust(key, parseInt(e.target.value, 10))}
              aria-label={label}
            />
            <span className="ac-slider-value">{weights[key]}%</span>
          </div>
        ))}
      </div>
    </div>,
    document.fullscreenElement ?? document.body,
  );
}
