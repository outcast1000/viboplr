import { describe, it, expect } from "vitest";
import { normalizeForMatch } from "../utils/normalize";

// Mirrors the backend's strip_diacritics(unicode_lower(...)) — the pairs the
// backend treats as equal must compare equal here too, or in-memory matching
// (sameSong, locate-in-library) drifts from the durable store's keys.
describe("normalizeForMatch", () => {
  it("lowercases", () => {
    expect(normalizeForMatch("BJÖRK")).toBe(normalizeForMatch("björk"));
  });

  it("strips diacritics the way the backend does", () => {
    expect(normalizeForMatch("Björk")).toBe("bjork");
    expect(normalizeForMatch("Jóga")).toBe("joga");
    expect(normalizeForMatch("Café del Mar")).toBe("cafe del mar");
    expect(normalizeForMatch("Motörhead")).toBe("motorhead");
  });

  it("handles non-Latin scripts without mangling them", () => {
    // Greek tonos is a combining mark after NFD — stripped, like the backend.
    expect(normalizeForMatch("Αλέξανδρος")).toBe(normalizeForMatch("ΑΛΕΞΑΝΔΡΟΣ"));
    // Scripts with no marks pass through.
    expect(normalizeForMatch("東京事変")).toBe("東京事変");
  });

  it("leaves plain ASCII alone", () => {
    expect(normalizeForMatch("plain title 42")).toBe("plain title 42");
  });
});
