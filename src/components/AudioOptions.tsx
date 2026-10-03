import { useCallback, useEffect, useState } from "react";
import { showNativeMenu, type MenuItemSpec } from "../nativeMenu";
import { EqControlGroup, type EqControls } from "./EqButton";
import { registerEqPanel, type EqHost } from "../utils/uiRemote";
import { BitPerfectButton, type BitPerfectControl } from "./BitPerfectButton";
import { BIT_PERFECT_EQ_REASON } from "../utils/bitPerfect";
import { bitPerfectOnBar, eqOnBar, type PlayerBarPins } from "../utils/playerBarPins";

/**
 * The advanced-audio cluster both playback bars render: one "Audio options"
 * button (a native menu) followed by whichever of Bit-perfect / EQ is on the
 * bar right now — see utils/playerBarPins for the rule.
 *
 * Both hosts render **this**, not the pieces, for the same reason they share
 * EqControlGroup: the docked and fullscreen bars must be arrangements of one
 * control, never two implementations that drift.
 */
interface AudioOptionsGroupProps {
  eq: EqControls;
  /** EQ can't run on browser-engine video (see EqControlGroup). */
  eqAvailable: boolean;
  /** Native engine on macOS or Windows; null hides every Bit-perfect affordance. */
  bitPerfect: BitPerfectControl | null;
  pins: PlayerBarPins;
  onPinsChange: (next: PlayerBarPins) => void;
  /** Fired while the menu or the EQ popover is up, so a host with an idle
   *  auto-hide (the fullscreen bar) can hold itself open. */
  onHoldChange?: (key: "audio-menu" | "eq", held: boolean) => void;
  /** Which bar this is, so the control API can open *this* bar's EQ popover
   *  (`utils/uiRemote.ts`). Omitted = not remotely addressable. */
  remoteHost?: EqHost;
}

export function AudioOptionsGroup({ eq, eqAvailable, bitPerfect, pins, onPinsChange, onHoldChange, remoteHost }: AudioOptionsGroupProps) {
  const [eqOpen, setEqOpen] = useState(false);
  const suspendedReason = bitPerfect?.on ? BIT_PERFECT_EQ_REASON : null;
  const eqUsable = eqAvailable && !suspendedReason;

  const handleEqOpenChange = useCallback((open: boolean) => {
    setEqOpen(open);
    onHoldChange?.("eq", open);
  }, [onHoldChange]);

  useEffect(() => {
    if (!remoteHost) return;
    return registerEqPanel(remoteHost, { isOpen: () => eqOpen, setOpen: handleEqOpenChange });
  }, [remoteHost, eqOpen, handleEqOpenChange]);

  const openMenu = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const eqNote = suspendedReason ? " (paused by Bit-perfect)" : !eqAvailable ? " (not available for this video)" : "";
    const specs: MenuItemSpec[] = [
      { kind: "check", text: `Equalizer${eqNote}`, checked: eq.enabled, enabled: eqUsable, action: () => eq.onEnabledChange(!eq.enabled) },
      { kind: "item", text: "Equalizer settings…", enabled: eqUsable, action: () => handleEqOpenChange(true) },
    ];
    if (bitPerfect) {
      specs.push(
        { kind: "separator" },
        { kind: "check", text: "Bit-perfect", checked: bitPerfect.on, action: bitPerfect.onToggle },
      );
    }
    const keep: MenuItemSpec[] = [
      { kind: "check", text: "Equalizer", checked: pins.eq, action: () => onPinsChange({ ...pins, eq: !pins.eq }) },
    ];
    if (bitPerfect) {
      keep.push({ kind: "check", text: "Bit-perfect", checked: pins.bitPerfect, action: () => onPinsChange({ ...pins, bitPerfect: !pins.bitPerfect }) });
    }
    specs.push({ kind: "separator" }, { kind: "submenu", text: "Keep in bar", items: keep });

    onHoldChange?.("audio-menu", true);
    showNativeMenu(rect.left, rect.bottom, specs)
      .catch((err) => console.error("Failed to show audio options menu:", err))
      .finally(() => onHoldChange?.("audio-menu", false));
  }, [eq, eqAvailable, eqUsable, suspendedReason, bitPerfect, pins, onPinsChange, onHoldChange, handleEqOpenChange]);

  return (
    <>
      <button
        className="g-btn g-btn-sm audio-options-btn"
        onClick={openMenu}
        title="Audio options"
        aria-label="Audio options"
      >
        {/* Mixer faders: reads as "sound settings" without being another EQ glyph. */}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" />
          <line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" />
          <line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
          <line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
        </svg>
      </button>
      {bitPerfect && bitPerfectOnBar(pins, bitPerfect.on) && <BitPerfectButton control={bitPerfect} />}
      {eqOnBar(pins, eq.enabled, eqOpen) && (
        <EqControlGroup
          eq={eq}
          available={eqAvailable}
          open={eqOpen}
          onOpenChange={handleEqOpenChange}
          suspendedReason={suspendedReason}
        />
      )}
    </>
  );
}
