import { describe, it, expect } from "vitest";
import { effectiveTagNames } from "../utils/bulkEditTags";

describe("effectiveTagNames", () => {
  it("includes committed pills", () => {
    expect(effectiveTagNames([{ name: "Rock" }, { name: "Live" }], "")).toEqual(["Rock", "Live"]);
  });

  it("flushes pending text as a final tag", () => {
    expect(effectiveTagNames([{ name: "Rock" }], "Live")).toEqual(["Rock", "Live"]);
  });

  it("trims pending text", () => {
    expect(effectiveTagNames([], "  Jazz  ")).toEqual(["Jazz"]);
  });

  it("does not duplicate pending text already present (case-insensitive)", () => {
    expect(effectiveTagNames([{ name: "Rock" }], "rock")).toEqual(["Rock"]);
  });

  it("ignores empty pending text", () => {
    expect(effectiveTagNames([{ name: "Rock" }], "   ")).toEqual(["Rock"]);
  });
});
