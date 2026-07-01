import { describe, it, expect } from "vitest";
import { computeSelection } from "../utils/rowSelection";

// The generic is exercised over both key types it's instantiated at in the app:
// string keys (library/playlist/plugin/history) and numeric indices (queue).
describe("computeSelection<string>", () => {
  const keys = ["a", "b", "c", "d", "e"];

  it("plain click selects only the clicked key", () => {
    expect(computeSelection(new Set(["a", "b"]), 2, keys, null, false, false)).toEqual(new Set(["c"]));
  });

  it("plain click on the sole selected key is idempotent", () => {
    expect(computeSelection(new Set(["c"]), 2, keys, null, false, false)).toEqual(new Set(["c"]));
  });

  it("meta+click toggles a key in", () => {
    expect(computeSelection(new Set(["a"]), 2, keys, null, true, false)).toEqual(new Set(["a", "c"]));
  });

  it("meta+click toggles a key out", () => {
    expect(computeSelection(new Set(["a", "c"]), 2, keys, null, true, false)).toEqual(new Set(["a"]));
  });

  it("shift+click selects a range from lastIndex", () => {
    expect(computeSelection(new Set(), 3, keys, 1, false, true)).toEqual(new Set(["b", "c", "d"]));
  });

  it("shift+click ranges regardless of direction", () => {
    expect(computeSelection(new Set(), 1, keys, 3, false, true)).toEqual(new Set(["b", "c", "d"]));
  });

  it("shift+click with no lastIndex ranges from the top", () => {
    expect(computeSelection(new Set(), 2, keys, null, false, true)).toEqual(new Set(["a", "b", "c"]));
  });

  it("plain shift+click replaces the existing selection with the range", () => {
    expect(computeSelection(new Set(["e"]), 2, keys, 0, false, true)).toEqual(new Set(["a", "b", "c"]));
  });

  it("meta+shift+click unions the range into the existing selection", () => {
    expect(computeSelection(new Set(["e"]), 2, keys, 0, true, true)).toEqual(new Set(["a", "b", "c", "e"]));
  });
});

describe("computeSelection<number> (queue index keying)", () => {
  // The queue passes the identity index array [0..n-1], so keys[i] === i.
  const keys = [0, 1, 2, 3, 4];

  it("plain click selects only the clicked index", () => {
    expect(computeSelection(new Set([0, 1]), 2, keys, null, false, false)).toEqual(new Set([2]));
  });

  it("meta+click toggles an index out", () => {
    expect(computeSelection(new Set([0, 2]), 2, keys, null, true, false)).toEqual(new Set([0]));
  });

  it("shift+click selects an index range", () => {
    expect(computeSelection(new Set(), 3, keys, 1, false, true)).toEqual(new Set([1, 2, 3]));
  });

  it("meta+shift+click unions an index range", () => {
    expect(computeSelection(new Set([4]), 2, keys, 0, true, true)).toEqual(new Set([0, 1, 2, 4]));
  });
});
