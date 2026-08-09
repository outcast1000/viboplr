import { describe, expect, it } from "vitest";
import { busGain } from "../components/VisualizerSlot";

/**
 * The level a visualizer's own noises play at.
 *
 * This is the whole reason the host grants an audio *destination* rather than a
 * bare context: a plugin connecting to `context.destination` would reach the
 * speakers directly, so its noises would ignore the volume slider and survive
 * mute. On the native mpv engine — the default — that isn't a subtlety, it's two
 * genuinely independent outputs: music leaves through mpv, WebAudio leaves
 * through the webview. Get this wrong and muting the app silences the music
 * while a deck keeps clicking to itself.
 */
describe("busGain", () => {
  it("is silent when muted, whatever the volume says", () => {
    expect(busGain(1, true)).toBe(0);
    expect(busGain(0.7, true)).toBe(0);
  });

  it("tracks the volume when not muted", () => {
    expect(busGain(1, false)).toBe(1);
    expect(busGain(0.5, false)).toBeCloseTo(0.5);
    expect(busGain(0, false)).toBe(0);
  });

  it("clamps out of range values rather than passing them to a gain node", () => {
    expect(busGain(4, false)).toBe(1);
    expect(busGain(-2, false)).toBe(0);
  });

  it("falls back to full rather than silence on a junk volume", () => {
    // A NaN reaching an AudioParam poisons it permanently — the node stays
    // silent with no way back short of rebuilding it. Full is the safer wrong
    // answer here, and it is also what a caller with no volume of its own gets.
    expect(busGain(NaN, false)).toBe(1);
    expect(busGain(undefined as unknown as number, false)).toBe(1);
  });
});
