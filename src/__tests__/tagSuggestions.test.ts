import { describe, it, expect } from "vitest";
import { buildTagSuggestionPool } from "../utils/tagSuggestions";

describe("buildTagSuggestionPool", () => {
  const libraryTags = [
    { name: "chill", track_count: 188 },
    { name: "rock", track_count: 312 },
    { name: "90s", track_count: 140 },
  ];

  it("sorts library tags by track_count descending", () => {
    expect(buildTagSuggestionPool(libraryTags, [])).toEqual(["rock", "chill", "90s"]);
  });

  it("appends community tags not already in the library pool", () => {
    const community = [{ name: "shoegaze" }, { name: "dreamy" }];
    expect(buildTagSuggestionPool(libraryTags, community)).toEqual([
      "rock", "chill", "90s", "shoegaze", "dreamy",
    ]);
  });

  it("dedups community tags against library case-insensitively", () => {
    const community = [{ name: "Rock" }, { name: "shoegaze" }];
    expect(buildTagSuggestionPool(libraryTags, community)).toEqual([
      "rock", "chill", "90s", "shoegaze",
    ]);
  });

  it("dedups community tags against each other", () => {
    const community = [{ name: "shoegaze" }, { name: "Shoegaze" }];
    expect(buildTagSuggestionPool([], community)).toEqual(["shoegaze"]);
  });

  it("returns empty for no input", () => {
    expect(buildTagSuggestionPool([], [])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = [...libraryTags];
    buildTagSuggestionPool(input, []);
    expect(input).toEqual(libraryTags);
  });
});
