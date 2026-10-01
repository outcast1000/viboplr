/**
 * Which advanced audio controls sit on the playback bars.
 *
 * EQ and Bit-perfect live behind the bars' single "Audio options" button and
 * surface on the bar only while they are doing something, or when the user
 * pinned them there ("Keep in bar", in that menu and in Settings → Playback).
 * Both bars — docked and fullscreen — read the same pins, so the two never
 * disagree about what is on screen.
 *
 * "Doing something" is deliberately `eq.enabled`, not "the curve is non-flat":
 * a shaping test would unmount the Bass/Treble slot the moment a drag passed
 * through 0 dB, right under the user's pointer.
 */
export interface PlayerBarPins {
  eq: boolean;
  bitPerfect: boolean;
}

export const DEFAULT_PLAYER_BAR_PINS: PlayerBarPins = { eq: false, bitPerfect: false };

/** Coerce a persisted value; anything unrecognised falls back to "nothing pinned". */
export function normalizePlayerBarPins(value: unknown): PlayerBarPins {
  const v = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof PlayerBarPins, unknown>>;
  return {
    eq: v.eq === true,
    bitPerfect: v.bitPerfect === true,
  };
}

/** The EQ cluster is on the bar while pinned, enabled, or its popover is open
 *  (opened from the Audio options menu, it needs the button as its anchor). */
export function eqOnBar(pins: PlayerBarPins, eqEnabled: boolean, popoverOpen: boolean): boolean {
  return pins.eq || eqEnabled || popoverOpen;
}

/** The Bit-perfect button is on the bar while pinned or while the mode is on —
 *  its verified-state colour is the only readout of whether it is working. */
export function bitPerfectOnBar(pins: PlayerBarPins, on: boolean): boolean {
  return pins.bitPerfect || on;
}
