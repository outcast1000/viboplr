import { describe, it, expect } from "vitest";
import { builtinQualityOptions } from "../utils/builtinDownloadQualities";

describe("builtinQualityOptions", () => {
  it("offers Subsonic a single 'Source original' option", () => {
    const opts = builtinQualityOptions("__builtin:subsonic");
    expect(opts).toHaveLength(1);
    expect(opts![0].value).toBe("original");
    expect(opts![0].label).toMatch(/^Audio · /);
    expect(opts![0].description).toBeTruthy();
  });

  it("returns null for non-builtin providers (plugins supply their own)", () => {
    expect(builtinQualityOptions("youtube:youtube-download")).toBeNull();
    expect(builtinQualityOptions("tidal-browse:tidal")).toBeNull();
  });

  it("returns null for unknown builtin providers", () => {
    expect(builtinQualityOptions("__builtin:something-else")).toBeNull();
  });
});
