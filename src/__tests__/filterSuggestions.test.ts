import { describe, it, expect } from "vitest";
import { filterSuggestions } from "../utils/filterSuggestions";

describe("filterSuggestions", () => {
  const pool = ["Rock", "Pop", "Post-Rock", "Jazz", "Hip-Hop"];

  it("matches case-insensitive substring", () => {
    expect(filterSuggestions(pool, "rock")).toEqual(["Rock", "Post-Rock"]);
  });

  it("returns all (capped) when query is empty", () => {
    expect(filterSuggestions(pool, "")).toEqual(pool);
  });

  it("trims the query before matching", () => {
    expect(filterSuggestions(pool, "  pop  ")).toEqual(["Pop"]);
  });

  it("excludes names in the exclude set (case-insensitive)", () => {
    expect(filterSuggestions(pool, "", new Set(["rock", "jazz"]))).toEqual([
      "Pop", "Post-Rock", "Hip-Hop",
    ]);
  });

  it("excludes case-insensitively regardless of exclude-set casing", () => {
    expect(filterSuggestions(pool, "", new Set(["ROCK", "Jazz"]))).toEqual([
      "Pop", "Post-Rock", "Hip-Hop",
    ]);
  });

  it("caps results at 8", () => {
    const many = Array.from({ length: 20 }, (_, i) => `Tag${i}`);
    expect(filterSuggestions(many, "tag")).toHaveLength(8);
  });

  it("returns empty array when nothing matches", () => {
    expect(filterSuggestions(pool, "zzz")).toEqual([]);
  });
});
