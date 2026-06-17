import { describe, it, expect } from "vitest";
import {
  isAuto,
  isProtectedSystem,
  playlistRank,
  parseRecipe,
  autoRecipeLabel,
  firstArtist,
  featuredArtists,
} from "../utils/autoPlaylist";

const p = (system_kind: string | null, metadata: string | null = null) => ({ system_kind, metadata });

describe("isAuto", () => {
  it("is true only for auto: kinds", () => {
    expect(isAuto(p("auto:genre:jazz"))).toBe(true);
    expect(isAuto(p("auto:discovery"))).toBe(true);
    expect(isAuto(p("liked"))).toBe(false);
    expect(isAuto(p("disliked"))).toBe(false);
    expect(isAuto(p(null))).toBe(false);
  });
});

describe("isProtectedSystem", () => {
  it("is true only for liked/disliked", () => {
    expect(isProtectedSystem(p("liked"))).toBe(true);
    expect(isProtectedSystem(p("disliked"))).toBe(true);
    expect(isProtectedSystem(p("auto:genre:jazz"))).toBe(false);
    expect(isProtectedSystem(p(null))).toBe(false);
  });
});

describe("playlistRank", () => {
  it("orders liked < disliked < auto < user", () => {
    expect(playlistRank(p("liked"))).toBe(0);
    expect(playlistRank(p("disliked"))).toBe(1);
    expect(playlistRank(p("auto:daily-mix:radiohead"))).toBe(2);
    expect(playlistRank(p(null))).toBe(3);
  });

  it("sorts a mixed list into the right order", () => {
    const list = [p(null), p("auto:genre:rock"), p("disliked"), p("liked")];
    const ranks = list.slice().sort((a, b) => playlistRank(a) - playlistRank(b)).map((x) => x.system_kind);
    expect(ranks).toEqual(["liked", "disliked", "auto:genre:rock", null]);
  });
});

describe("parseRecipe", () => {
  it("extracts the recipe from valid metadata", () => {
    expect(parseRecipe(JSON.stringify({ recipe: "daily-mix", seed_artist: "X" }))).toBe("daily-mix");
    expect(parseRecipe(JSON.stringify({ recipe: "genre", tag: "jazz" }))).toBe("genre");
    expect(parseRecipe(JSON.stringify({ recipe: "decade", start: 1990 }))).toBe("decade");
    expect(parseRecipe(JSON.stringify({ recipe: "discovery" }))).toBe("discovery");
  });

  it("returns unknown for missing, malformed, or unrecognized metadata (never throws)", () => {
    expect(parseRecipe(null)).toBe("unknown");
    expect(parseRecipe(undefined)).toBe("unknown");
    expect(parseRecipe("not json {{{")).toBe("unknown");
    expect(parseRecipe(JSON.stringify({ recipe: "bogus" }))).toBe("unknown");
    expect(parseRecipe(JSON.stringify({ nope: true }))).toBe("unknown");
  });
});

describe("firstArtist", () => {
  it("extracts a non-empty first_artist string", () => {
    expect(firstArtist(JSON.stringify({ recipe: "genre", first_artist: "Radiohead" }))).toBe("Radiohead");
  });

  it("returns null for missing, empty, null, or malformed metadata (never throws)", () => {
    expect(firstArtist(null)).toBe(null);
    expect(firstArtist(undefined)).toBe(null);
    expect(firstArtist("not json {{{")).toBe(null);
    expect(firstArtist(JSON.stringify({ recipe: "genre" }))).toBe(null);
    expect(firstArtist(JSON.stringify({ first_artist: "" }))).toBe(null);
    expect(firstArtist(JSON.stringify({ first_artist: null }))).toBe(null);
  });
});

describe("autoRecipeLabel", () => {
  it("maps each recipe to a human label", () => {
    expect(autoRecipeLabel("daily-mix")).toBe("Daily mix");
    expect(autoRecipeLabel("genre")).toBe("Genre mix");
    expect(autoRecipeLabel("decade")).toBe("Decade mix");
    expect(autoRecipeLabel("discovery")).toBe("For you");
    expect(autoRecipeLabel("unknown")).toBe("Auto playlist");
  });
});

describe("featuredArtists", () => {
  const t = (artist_name: string | null) => ({ artist_name });

  it("ranks by track count descending and caps at max", () => {
    const tracks = [
      t("A"), t("A"), t("A"),
      t("B"), t("B"),
      t("C"),
      t("D"),
      t("E"),
    ];
    expect(featuredArtists(tracks, 4)).toEqual(["A", "B", "C", "D"]);
  });

  it("skips blank/null artist names", () => {
    expect(featuredArtists([t(null), t(""), t("  "), t("A")])).toEqual(["A"]);
  });

  it("returns empty for no artists", () => {
    expect(featuredArtists([])).toEqual([]);
    expect(featuredArtists([t(null)])).toEqual([]);
  });

  it("keeps first-seen order on ties", () => {
    expect(featuredArtists([t("X"), t("Y"), t("Z")], 4)).toEqual(["X", "Y", "Z"]);
  });
});
