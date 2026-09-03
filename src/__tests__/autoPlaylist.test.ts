import { describe, it, expect } from "vitest";
import {
  isAuto,
  isProtectedSystem,
  playlistRank,
  parseRecipe,
  autoRecipeLabel,
  firstArtist,
  featuredArtists,
  featuredArtistsFromMetadata,
  featuredArtistsLabel,
  parsePlaylistMetadata,
  playlistKind,
  playlistKindLabel,
  comparePlaylists,
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

describe("featuredArtistsFromMetadata", () => {
  it("reads a string array of featured artists", () => {
    expect(featuredArtistsFromMetadata(JSON.stringify({ recipe: "genre", featured_artists: ["A", "B"] }))).toEqual(["A", "B"]);
  });

  it("filters out blank/non-string entries", () => {
    expect(featuredArtistsFromMetadata(JSON.stringify({ featured_artists: ["A", "", "  ", 3, null, "B"] }))).toEqual(["A", "B"]);
  });

  it("returns [] for missing, legacy, null, or malformed metadata (never throws)", () => {
    expect(featuredArtistsFromMetadata(null)).toEqual([]);
    expect(featuredArtistsFromMetadata(undefined)).toEqual([]);
    expect(featuredArtistsFromMetadata("not json {{{")).toEqual([]);
    expect(featuredArtistsFromMetadata(JSON.stringify({ recipe: "genre" }))).toEqual([]);
    expect(featuredArtistsFromMetadata(JSON.stringify({ featured_artists: "nope" }))).toEqual([]);
  });
});

describe("featuredArtistsLabel", () => {
  it("joins up to `shown` names with commas", () => {
    expect(featuredArtistsLabel(["A", "B", "C"])).toBe("A, B, C");
    expect(featuredArtistsLabel(["A", "B"], 3)).toBe("A, B");
  });

  it("appends 'and more' when the list exceeds `shown`", () => {
    expect(featuredArtistsLabel(["A", "B", "C", "D"])).toBe("A, B, C and more");
    expect(featuredArtistsLabel(["A", "B", "C"], 2)).toBe("A, B and more");
  });

  it("returns null for an empty list", () => {
    expect(featuredArtistsLabel([])).toBe(null);
  });
});

describe("parsePlaylistMetadata", () => {
  it("flattens a real auto-mix row into an all-string map", () => {
    // Verbatim shape from the playlists table. Every consumer hands this to a
    // backend command typed HashMap<String, String>; the array alone rejected
    // main_playlist_write, so the live queue silently stopped persisting.
    const row = JSON.stringify({
      featured_artists: ["Wipers", "Dead Moon", "Mark Lanegan"],
      first_artist: "Wipers",
      recipe: "daily-mix",
      seed_artist: "Wipers",
      seed_title: null,
      tag_id: 2,
    });
    expect(parsePlaylistMetadata(row)).toEqual({
      featured_artists: "Wipers, Dead Moon, Mark Lanegan",
      first_artist: "Wipers",
      recipe: "daily-mix",
      seed_artist: "Wipers",
      tag_id: "2",
    });
  });

  it("returns null for missing, malformed, or all-unusable metadata", () => {
    expect(parsePlaylistMetadata(null)).toBe(null);
    expect(parsePlaylistMetadata(undefined)).toBe(null);
    expect(parsePlaylistMetadata("not json {{{")).toBe(null);
    expect(parsePlaylistMetadata("{}")).toBe(null);
    expect(parsePlaylistMetadata(JSON.stringify({ seed_title: null }))).toBe(null);
  });
});

describe("playlistKind / playlistKindLabel", () => {
  it("classifies the three playlist classes", () => {
    expect(playlistKind(p("liked"))).toBe("system");
    expect(playlistKind(p("disliked"))).toBe("system");
    expect(playlistKind(p("auto:genre:jazz"))).toBe("auto");
    expect(playlistKind(p(null))).toBe("user");
  });

  it("labels each kind", () => {
    expect(playlistKindLabel("system")).toBe("System");
    expect(playlistKindLabel("auto")).toBe("Made for you");
    expect(playlistKindLabel("user")).toBe("Saved");
  });
});

describe("comparePlaylists", () => {
  const pl = (name: string, track_count: number, saved_at: number, system_kind: string | null = null) =>
    ({ name, track_count, saved_at, system_kind, metadata: null });

  it("falls back to playlistRank on an empty chain", () => {
    const sorted = [pl("Zed", 1, 1), pl("Mix", 5, 1, "auto:genre:x"), pl("Liked", 5, 1, "liked")]
      .sort((a, b) => comparePlaylists(a, b, []));
    expect(sorted.map(r => r.name)).toEqual(["Liked", "Mix", "Zed"]);
  });

  it("sorts by name case-insensitively, both directions", () => {
    const rows = [pl("banana", 1, 1), pl("Apple", 1, 1), pl("cherry", 1, 1)];
    expect(rows.slice().sort((a, b) => comparePlaylists(a, b, [{ field: "name", dir: "asc" }])).map(r => r.name))
      .toEqual(["Apple", "banana", "cherry"]);
    expect(rows.slice().sort((a, b) => comparePlaylists(a, b, [{ field: "name", dir: "desc" }])).map(r => r.name))
      .toEqual(["cherry", "banana", "Apple"]);
  });

  it("sorts by tracks and updated", () => {
    const rows = [pl("a", 3, 100), pl("b", 1, 300), pl("c", 2, 200)];
    expect(rows.slice().sort((a, b) => comparePlaylists(a, b, [{ field: "tracks", dir: "asc" }])).map(r => r.name))
      .toEqual(["b", "c", "a"]);
    expect(rows.slice().sort((a, b) => comparePlaylists(a, b, [{ field: "updated", dir: "desc" }])).map(r => r.name))
      .toEqual(["b", "c", "a"]);
  });

  it("applies later chain keys only on ties, then rank", () => {
    const rows = [pl("b", 2, 1), pl("a", 2, 1), pl("c", 1, 1)];
    const chain = [{ field: "tracks", dir: "desc" as const }, { field: "name", dir: "asc" as const }];
    expect(rows.slice().sort((a, b) => comparePlaylists(a, b, chain)).map(r => r.name))
      .toEqual(["a", "b", "c"]);
    // Equal on every chain key → class ranking decides (system before user).
    const tie = [pl("x", 2, 1), pl("x", 2, 1, "liked")];
    expect(tie.slice().sort((a, b) => comparePlaylists(a, b, chain)).map(r => r.system_kind))
      .toEqual(["liked", null]);
  });

  it("ignores unknown fields instead of throwing", () => {
    expect(comparePlaylists(pl("a", 1, 1), pl("b", 1, 1), [{ field: "bogus", dir: "asc" }])).toBe(0);
  });
});
