import type { BitPerfectTone } from "../utils/bitPerfect";
import "./BitPerfectButton.css";

/** What a playback bar needs to render the Bit-perfect toggle (see useBitPerfect). */
export interface BitPerfectControl {
  on: boolean;
  /** Verified state while on; ignored while off. */
  tone: BitPerfectTone;
  /** Tooltip: the verified state while on, the offer while off. */
  text: string;
  onToggle: () => void;
  /** On, and the device has no volume of its own: the slider stays at 100%. */
  volumeLocked: boolean;
  /** On, with the slider driving the device's own level: its tooltip. */
  volumeNote: string | null;
}

/**
 * The Bit-perfect toggle. Off it is a plain button; on, its colour is the
 * *verified* state — green only when the engine confirmed exclusive access and
 * matching rates, amber whenever something is in the way, neutral while idle or
 * checking. Clicking while on turns the mode off, which is also the "play shared
 * instead" escape from a busy device.
 */
export function BitPerfectButton({ control }: { control: BitPerfectControl }) {
  const { on, tone, text, onToggle } = control;
  return (
    <button
      className={`g-btn g-btn-sm bit-perfect-btn${on ? ` is-on tone-${tone}` : ""}`}
      onClick={onToggle}
      title={text}
      aria-label="Bit-perfect"
      aria-pressed={on}
    >
      {/* A faceted gem: maximum quality, and unmistakably not another EQ glyph. */}
      <svg width="14" height="13" viewBox="0 0 16 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 1.5h8l3 4-7 8-7-8z" />
        <path d="M1 5.5h14M6 1.5l-1 4 3 8 3-8-1-4" />
      </svg>
      {on && tone !== "neutral" && <span className="bit-perfect-dot" aria-hidden="true" />}
    </button>
  );
}
