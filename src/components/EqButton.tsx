import { useCallback, useEffect, useRef, useState } from "react";
import { EqPopover } from "./EqPopover";
import { EqBarControl } from "./EqBarControl";
import type { EqMode, EqPreset } from "../eqPresets";

/**
 * Everything the EQ button + its popover need, as one bundle.
 *
 * Two hosts pass it — the now-playing bar and the fullscreen bar — and the
 * popover already takes eighteen loose props. Threading those through a second
 * call site is how the fullscreen bar came to have no EQ at all: nobody wanted
 * to copy the list. The bundle is what makes "both bars, one control" cheap
 * enough to stay true.
 */
export interface EqControls {
  enabled: boolean;
  mode: EqMode;
  preset: string;
  gains: number[];
  preGainDb: number;
  bassDb: number;
  trebleDb: number;
  customPresets: EqPreset[];
  onEnabledChange: (v: boolean) => void;
  onModeChange: (mode: EqMode) => void;
  onPresetChange: (id: string) => void;
  onGainChange: (bandIndex: number, gainDb: number) => void;
  onPreGainChange: (db: number) => void;
  onBassChange: (db: number) => void;
  onTrebleChange: (db: number) => void;
  onResetAll: () => void;
  onSaveAs: () => void;
  showBarControl: boolean;
  onShowBarControlChange: (v: boolean) => void;
}

interface EqGroupProps {
  eq: EqControls;
  /** EQ is available for audio always, and for video only on the native mpv
   *  engine (lavfi graph on the deck). Browser-engine video can't be EQ'd — its
   *  `<video>` element isn't wired into the Web Audio graph. */
  available: boolean;
  /** Fired whenever the popover opens or closes, so a host with an idle
   *  auto-hide (the fullscreen bar) can hold itself open while it is up. */
  onOpenChange?: (open: boolean) => void;
}

/** Is the EQ doing anything audible? Drives the button's `active` styling. */
function isShaping(eq: EqControls): boolean {
  if (!eq.enabled) return false;
  return eq.mode === "simple" ? eq.bassDb !== 0 || eq.trebleDb !== 0 : eq.preset !== "flat";
}

/**
 * The whole equalizer cluster: the inline slot (simple → bipolar Bass/Treble
 * sliders, advanced → a read-only curve preview) followed by the button that
 * opens the popover.
 *
 * Both hosts render **this**, not the pieces. Rendering only the button in
 * fullscreen is exactly the bug this replaced — the windowed bar showed live
 * Bass/Treble sliders and fullscreen showed a lone icon, so "the same EQ" was
 * two different controls depending on the chrome.
 */
export function EqControlGroup({ eq, available, onOpenChange }: EqGroupProps) {
  return (
    <>
      {available && eq.showBarControl && (
        <EqBarControl
          mode={eq.mode}
          enabled={eq.enabled}
          bassDb={eq.bassDb}
          trebleDb={eq.trebleDb}
          gains={eq.gains}
          preGainDb={eq.preGainDb}
          onBassChange={eq.onBassChange}
          onTrebleChange={eq.onTrebleChange}
          onEnsureEnabled={() => { if (!eq.enabled) eq.onEnabledChange(true); }}
        />
      )}
      <EqButton eq={eq} available={available} onOpenChange={onOpenChange} />
    </>
  );
}

export function EqButton({ eq, available, onOpenChange }: EqGroupProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  const setOpenState = useCallback((next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  }, [onOpenChange]);

  // Availability can drop out from under an open popover (the queue advances to
  // a browser-engine video), which unmounts it. Report the close too, or a host
  // that pinned itself open on our word stays pinned forever.
  useEffect(() => {
    if (!available && open) setOpenState(false);
  }, [available, open, setOpenState]);

  return (
    <div className="eq-button-wrapper">
      <button
        ref={anchorRef}
        className={`g-btn g-btn-sm now-playing-eq-btn${isShaping(eq) ? " active" : ""}`}
        onClick={() => { if (available) setOpenState(!open); }}
        disabled={!available}
        title={available ? "Equalizer" : "EQ unavailable for video on the browser engine"}
        aria-label="Equalizer"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <rect x="2" y="6" width="2" height="8" />
          <rect x="7" y="2" width="2" height="12" />
          <rect x="12" y="9" width="2" height="5" />
        </svg>
      </button>
      {open && available && (
        <EqPopover
          enabled={eq.enabled}
          mode={eq.mode}
          preset={eq.preset}
          gains={eq.gains}
          preGainDb={eq.preGainDb}
          bassDb={eq.bassDb}
          trebleDb={eq.trebleDb}
          customPresets={eq.customPresets}
          onEnabledChange={eq.onEnabledChange}
          onModeChange={eq.onModeChange}
          onPresetChange={eq.onPresetChange}
          onGainChange={eq.onGainChange}
          onPreGainChange={eq.onPreGainChange}
          onBassChange={eq.onBassChange}
          onTrebleChange={eq.onTrebleChange}
          onResetAll={eq.onResetAll}
          onSaveAs={eq.onSaveAs}
          showBarControl={eq.showBarControl}
          onShowBarControlChange={eq.onShowBarControlChange}
          onClose={() => setOpenState(false)}
          anchorRef={anchorRef}
        />
      )}
    </div>
  );
}
