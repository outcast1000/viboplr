import { describe, it, expect } from "vitest";
import { shouldWakeMiniSearch } from "../utils/miniSearchTrigger";

// Minimal shape of the fields shouldWakeMiniSearch reads off a KeyboardEvent.
function ev(partial: Partial<{
  key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing: boolean;
}>) {
  return { key: "a", ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...partial };
}

describe("shouldWakeMiniSearch", () => {
  it("wakes on a single printable letter", () => {
    expect(shouldWakeMiniSearch(ev({ key: "d" }), { miniMode: true, inputFocused: false, searchOpen: false })).toBe(true);
  });

  it("wakes on a digit and punctuation", () => {
    expect(shouldWakeMiniSearch(ev({ key: "7" }), { miniMode: true, inputFocused: false, searchOpen: false })).toBe(true);
    expect(shouldWakeMiniSearch(ev({ key: "!" }), { miniMode: true, inputFocused: false, searchOpen: false })).toBe(true);
  });

  it("does NOT wake on Space", () => {
    expect(shouldWakeMiniSearch(ev({ key: " " }), { miniMode: true, inputFocused: false, searchOpen: false })).toBe(false);
  });

  it("does NOT wake on arrows or named keys", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", "Escape", "Tab", "Backspace"]) {
      expect(shouldWakeMiniSearch(ev({ key }), { miniMode: true, inputFocused: false, searchOpen: false })).toBe(false);
    }
  });

  it("does NOT wake with a modifier held", () => {
    expect(shouldWakeMiniSearch(ev({ key: "d", metaKey: true }), { miniMode: true, inputFocused: false, searchOpen: false })).toBe(false);
    expect(shouldWakeMiniSearch(ev({ key: "d", ctrlKey: true }), { miniMode: true, inputFocused: false, searchOpen: false })).toBe(false);
    expect(shouldWakeMiniSearch(ev({ key: "d", altKey: true }), { miniMode: true, inputFocused: false, searchOpen: false })).toBe(false);
  });

  it("does NOT wake while composing (IME / dead keys)", () => {
    expect(shouldWakeMiniSearch(ev({ key: "a", isComposing: true }), { miniMode: true, inputFocused: false, searchOpen: false })).toBe(false);
  });

  it("does NOT wake when not in mini mode, an input is focused, or search already open", () => {
    expect(shouldWakeMiniSearch(ev({ key: "d" }), { miniMode: false, inputFocused: false, searchOpen: false })).toBe(false);
    expect(shouldWakeMiniSearch(ev({ key: "d" }), { miniMode: true, inputFocused: true, searchOpen: false })).toBe(false);
    expect(shouldWakeMiniSearch(ev({ key: "d" }), { miniMode: true, inputFocused: false, searchOpen: true })).toBe(false);
  });
});
