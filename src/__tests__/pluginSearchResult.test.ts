import { describe, it, expect } from "vitest";
import type { PluginSearchResult } from "../types/plugin";
import { normalizeSearchResult, SEARCH_SNIPPET_MAX } from "../utils/pluginSearchResult";

// Provider answers are plugin code, so the tests feed shapes the type forbids.
const raw = (v: unknown) => v as PluginSearchResult;

describe("normalizeSearchResult", () => {
  it("fills in the lists an older provider never sends", () => {
    expect(normalizeSearchResult({ status: "ok", tracks: [{ title: "Song" }] })).toEqual({
      status: "ok",
      tracks: [{ title: "Song" }],
      artists: [],
      albums: [],
    });
  });

  it("keeps a result that found only artists or albums", () => {
    const result = normalizeSearchResult(raw({
      status: "ok",
      artists: [{ name: "Radiohead", image_url: "https://x/r.png", subtitle: "5M listeners" }],
      albums: [{ title: "OK Computer", artist_name: "Radiohead" }],
    }));
    expect(result).toEqual({
      status: "ok",
      tracks: [],
      artists: [{ name: "Radiohead", image_url: "https://x/r.png", subtitle: "5M listeners" }],
      albums: [{ title: "OK Computer", artist_name: "Radiohead", image_url: null }],
    });
  });

  it("drops rows the dropdown couldn't label", () => {
    const result = normalizeSearchResult(raw({
      status: "ok",
      tracks: [{ title: "" }, null, { title: "Kept" }, { artist_name: "no title" }],
      artists: [{ name: "  " }, "Radiohead", { name: "Kept" }],
      albums: [{ artist_name: "A" }, { title: "Kept", artist_name: 7 }],
    }));
    expect(result).toEqual({
      status: "ok",
      tracks: [{ title: "Kept" }],
      artists: [{ name: "Kept", image_url: null, subtitle: null }],
      albums: [{ title: "Kept", artist_name: null, image_url: null }],
    });
  });

  it("calls an ok answer with nothing usable in it a miss", () => {
    expect(normalizeSearchResult(raw({ status: "ok", tracks: [], artists: [{ name: "" }] }))).toEqual({
      status: "empty",
    });
  });

  it("treats no answer and an unknown status as empty, and keeps an error's message", () => {
    expect(normalizeSearchResult(undefined)).toEqual({ status: "empty" });
    expect(normalizeSearchResult(raw({ status: "maybe" }))).toEqual({ status: "empty" });
    expect(normalizeSearchResult({ status: "error", message: "rate limited" })).toEqual({
      status: "error",
      message: "rate limited",
    });
  });

  it("flattens and caps a track's snippet, and nulls a blank or non-string one", () => {
    const long = "word ".repeat(60);
    const result = normalizeSearchResult(raw({
      status: "ok",
      tracks: [
        { title: "A", snippet: "Could have\n  a soul   of heaven" },
        { title: "B", snippet: long },
        { title: "C", snippet: "   " },
        { title: "D", snippet: 42 },
        { title: "E" },
      ],
    }));
    if (result.status !== "ok") throw new Error("expected ok");
    const [a, b, c, d, e] = result.tracks;
    expect(a.snippet).toBe("Could have a soul of heaven");
    expect(b.snippet!.length).toBe(SEARCH_SNIPPET_MAX);
    expect(b.snippet!.endsWith("…")).toBe(true);
    expect(c.snippet).toBeNull();
    expect(d.snippet).toBeNull();
    expect(e).toEqual({ title: "E" });
  });
});
