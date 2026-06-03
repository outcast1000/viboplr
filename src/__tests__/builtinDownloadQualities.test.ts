import { describe, it, expect } from "vitest";
import { builtinQualityOptions } from "../utils/builtinDownloadQualities";

describe("builtinQualityOptions", () => {
  it("offers Subsonic a single 'Source original' option", () => {
    const opts = builtinQualityOptions("__builtin:subsonic");
    expect(opts).toEqual([{ value: "original", label: "Source original" }]);
  });

  it("returns null for non-builtin providers (plugins supply their own)", () => {
    expect(builtinQualityOptions("youtube:youtube-download")).toBeNull();
    expect(builtinQualityOptions("tidal-browse:tidal")).toBeNull();
  });

  it("returns null for unknown builtin providers", () => {
    expect(builtinQualityOptions("__builtin:something-else")).toBeNull();
  });
});
