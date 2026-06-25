import { describe, it, expect } from "vitest";
import { computeRowSelection } from "../components/pluginViews/pluginViews";

// Plugin rows are keyed by their string `id` (a bare videoId for the YouTube
// view). Mirrors computeSelection.test.ts but for the id-keyed plugin list.
const items = [
  { id: "a" },
  { id: "b" },
  { id: "c" },
  { id: "d" },
  { id: "e" },
];

describe("computeRowSelection", () => {
  it("plain click selects only the clicked row", () => {
    const result = computeRowSelection(new Set(["a", "b"]), items, 2, null, false, false);
    expect(result).toEqual(new Set(["c"]));
  });

  it("plain click on the sole selected row is idempotent", () => {
    const result = computeRowSelection(new Set(["c"]), items, 2, null, false, false);
    expect(result).toEqual(new Set(["c"]));
  });

  it("meta+click toggles a row into the selection", () => {
    const result = computeRowSelection(new Set(["a"]), items, 2, null, true, false);
    expect(result).toEqual(new Set(["a", "c"]));
  });

  it("meta+click toggles a row out of the selection", () => {
    const result = computeRowSelection(new Set(["a", "c"]), items, 2, null, true, false);
    expect(result).toEqual(new Set(["a"]));
  });

  it("shift+click selects a range from lastIndex", () => {
    const result = computeRowSelection(new Set(), items, 3, 1, false, true);
    expect(result).toEqual(new Set(["b", "c", "d"]));
  });

  it("shift+click ranges work regardless of click direction", () => {
    const result = computeRowSelection(new Set(), items, 1, 3, false, true);
    expect(result).toEqual(new Set(["b", "c", "d"]));
  });

  it("shift+click with no prior index ranges from the top", () => {
    const result = computeRowSelection(new Set(), items, 2, null, false, true);
    expect(result).toEqual(new Set(["a", "b", "c"]));
  });

  it("plain shift+click replaces the existing selection with the range", () => {
    const result = computeRowSelection(new Set(["e"]), items, 2, 0, false, true);
    expect(result).toEqual(new Set(["a", "b", "c"]));
  });

  it("meta+shift+click merges the range into the existing selection", () => {
    const result = computeRowSelection(new Set(["e"]), items, 2, 0, true, true);
    expect(result).toEqual(new Set(["a", "b", "c", "e"]));
  });
});
