// Pure decision logic for the profile-switch flow (unit-tested; the
// useProfileSwitch hook is a thin shell around this).

export type SwitchDecision = "ignore" | "switch-without-flush" | "flush-then-switch";

/**
 * What a switch request should do given current app state.
 * - In-flight switch → ignore (single-flight: first request wins).
 * - Before restore completes → switch without flushing: nothing is dirty yet,
 *   and flushing pre-restore would overwrite the saved queue with the empty
 *   default (the same hazard the restoredRef guard exists for).
 * - Otherwise → flush both debounced writers, then switch.
 */
export function decideSwitchAction(restored: boolean, inFlight: boolean): SwitchDecision {
  if (inFlight) return "ignore";
  return restored ? "flush-then-switch" : "switch-without-flush";
}
