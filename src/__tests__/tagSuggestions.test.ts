import { describe, it, expect } from "vitest";
import { buildTagSuggestionPool, appendCommunityTags, selectSuggestionPills, rankCommunityTags } from "../utils/tagSuggestions";

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

describe("appendCommunityTags", () => {
  it("appends community tags after the existing ranked pool", () => {
    expect(appendCommunityTags(["rock", "chill"], [{ name: "shoegaze" }, { name: "dreamy" }]))
      .toEqual(["rock", "chill", "shoegaze", "dreamy"]);
  });

  it("preserves the existing pool order", () => {
    expect(appendCommunityTags(["b", "a", "c"], [{ name: "d" }]))
      .toEqual(["b", "a", "c", "d"]);
  });

  it("skips community tags already in the pool case-insensitively", () => {
    expect(appendCommunityTags(["Rock", "chill"], [{ name: "rock" }, { name: "jazz" }]))
      .toEqual(["Rock", "chill", "jazz"]);
  });

  it("dedups community tags against each other", () => {
    expect(appendCommunityTags([], [{ name: "shoegaze" }, { name: "Shoegaze" }]))
      .toEqual(["shoegaze"]);
  });

  it("returns the pool unchanged when there are no community tags", () => {
    expect(appendCommunityTags(["rock", "chill"], [])).toEqual(["rock", "chill"]);
  });

  it("does not mutate the input pool", () => {
    const pool = ["rock", "chill"];
    appendCommunityTags(pool, [{ name: "jazz" }]);
    expect(pool).toEqual(["rock", "chill"]);
  });
});

describe("selectSuggestionPills", () => {
  it("returns suggestions in order, capped at max", () => {
    expect(selectSuggestionPills(["a", "b", "c", "d"], [], 2)).toEqual(["a", "b"]);
  });

  it("filters out already-applied tags case-insensitively", () => {
    expect(selectSuggestionPills(["Rock", "indie", "90s"], ["rock"], 12))
      .toEqual(["indie", "90s"]);
  });

  it("dedups suggestions against each other", () => {
    expect(selectSuggestionPills(["indie", "Indie", "rock"], [], 12))
      .toEqual(["indie", "rock"]);
  });

  it("counts only kept items toward the cap (applied tags don't consume slots)", () => {
    expect(selectSuggestionPills(["rock", "indie", "90s", "sad"], ["rock"], 2))
      .toEqual(["indie", "90s"]);
  });

  it("returns empty when there are no suggestions", () => {
    expect(selectSuggestionPills([], ["rock"], 12)).toEqual([]);
  });

  it("does not mutate the inputs", () => {
    const suggested = ["a", "b"];
    const applied = ["a"];
    selectSuggestionPills(suggested, applied, 12);
    expect(suggested).toEqual(["a", "b"]);
    expect(applied).toEqual(["a"]);
  });
});

describe("rankCommunityTags", () => {
  it("ranks tags shared by more lists higher", () => {
    const result = rankCommunityTags([
      [{ name: "rock" }, { name: "indie" }],
      [{ name: "rock" }, { name: "pop" }],
      [{ name: "rock" }, { name: "indie" }],
    ]);
    // rock (3) > indie (2) > pop (1)
    expect(result.map((t) => t.name)).toEqual(["rock", "indie", "pop"]);
  });

  it("breaks ties by first-seen order", () => {
    const result = rankCommunityTags([
      [{ name: "alpha" }, { name: "beta" }],
      [{ name: "gamma" }],
    ]);
    // all count 1 → original encounter order
    expect(result.map((t) => t.name)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("counts each list at most once per tag (duplicates within a list don't inflate)", () => {
    const result = rankCommunityTags([
      [{ name: "rock" }, { name: "rock" }, { name: "indie" }],
      [{ name: "indie" }],
    ]);
    // indie appears in 2 lists, rock in 1 (despite dup) → indie first
    expect(result.map((t) => t.name)).toEqual(["indie", "rock"]);
  });

  it("dedups case-insensitively, preserving first casing", () => {
    const result = rankCommunityTags([
      [{ name: "Rock" }],
      [{ name: "rock" }],
    ]);
    expect(result.map((t) => t.name)).toEqual(["Rock"]);
  });

  it("returns empty for no lists or empty lists", () => {
    expect(rankCommunityTags([])).toEqual([]);
    expect(rankCommunityTags([[], []])).toEqual([]);
  });
});
