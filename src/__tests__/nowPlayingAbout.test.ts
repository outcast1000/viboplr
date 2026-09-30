import { describe, it, expect } from "vitest";
import { hasAboutText, summarizeAboutTab, buildAboutData } from "../hooks/useNowPlayingAbout";
import { pickAboutTab } from "../components/NowPlayingAbout";
import type { InfoSection } from "../types/informationTypes";

const loaded = (typeId: string, data: unknown, displayKind: InfoSection["displayKind"] = "rich_text"): InfoSection => ({
  typeId, name: typeId, displayKind, state: { kind: "loaded", data, stale: false },
});
const loading = (typeId: string): InfoSection => ({
  typeId, name: typeId, displayKind: "rich_text", state: { kind: "loading" },
});
const empty = (typeId: string): InfoSection => ({
  typeId, name: typeId, displayKind: "rich_text", state: { kind: "empty" },
});

describe("hasAboutText", () => {
  it("accepts real prose for each reading kind", () => {
    expect(hasAboutText("rich_text", { summary: "Björk is an Icelandic singer." })).toBe(true);
    expect(hasAboutText("html", { content: "<p>Recorded in 1997.</p>" })).toBe(true);
    expect(hasAboutText("annotated_text", { sections: [{ text: "The song is about…" }] })).toBe(true);
    expect(hasAboutText("annotated_text", { overview: "Overview", sections: [] })).toBe(true);
  });

  it("rejects an ok answer that carries no text (tags only, blank, missing)", () => {
    expect(hasAboutText("rich_text", { summary: "  <br/> " })).toBe(false);
    expect(hasAboutText("rich_text", {})).toBe(false);
    expect(hasAboutText("html", { content: "" })).toBe(false);
    expect(hasAboutText("annotated_text", { sections: [{ text: "<p></p>" }] })).toBe(false);
    expect(hasAboutText("rich_text", null)).toBe(false);
  });

  it("never treats a non-reading kind as prose", () => {
    expect(hasAboutText("ranked_list", { items: [{ name: "x", value: 1 }] })).toBe(false);
  });
});

describe("summarizeAboutTab", () => {
  it("lists only sections with text, and reports a provider still out", () => {
    const r = summarizeAboutTab("artist", [loaded("artist_bio", { summary: "Bio" }), loading("other"), empty("x")]);
    expect(r.tab?.entries.map((e) => e.typeId)).toEqual(["artist_bio"]);
    expect(r.tab?.label).toBe("Artist");
    expect(r.loading).toBe(true);
  });

  it("returns no tab when nothing has text", () => {
    const r = summarizeAboutTab("song", [loaded("wiki", { summary: "" }), empty("y")]);
    expect(r.tab).toBeNull();
    expect(r.loading).toBe(false);
  });
});

describe("buildAboutData", () => {
  it("keeps Song → Artist → Album order and drops empty tabs", () => {
    const d = buildAboutData([
      { id: "song", sections: [empty("s")], ready: true },
      { id: "artist", sections: [loaded("artist_bio", { summary: "Bio" })], ready: true },
      { id: "album", sections: [loaded("album_wiki", { summary: "Review" })], ready: true },
    ]);
    expect(d.tabs.map((t) => t.id)).toEqual(["artist", "album"]);
    expect(d.pending).toBe(false);
  });

  it("ignores a not-ready entity's (possibly previous-track) sections but marks pending", () => {
    const d = buildAboutData([
      { id: "song", sections: [], ready: true },
      { id: "artist", sections: [loaded("artist_bio", { summary: "Old artist" })], ready: false },
      { id: "album", sections: [], ready: true },
    ]);
    expect(d.tabs).toEqual([]);
    expect(d.pending).toBe(true);
  });

  it("is settled and empty when every provider answered with nothing", () => {
    const d = buildAboutData([
      { id: "song", sections: [empty("a")], ready: true },
      { id: "artist", sections: [empty("b")], ready: true },
      { id: "album", sections: [], ready: true },
    ]);
    expect(d).toEqual({ tabs: [], pending: false });
  });
});

describe("pickAboutTab", () => {
  const data = buildAboutData([
    { id: "song", sections: [], ready: true },
    { id: "artist", sections: [loaded("artist_bio", { summary: "Bio" })], ready: true },
    { id: "album", sections: [loaded("album_wiki", { summary: "Review" })], ready: true },
  ]);

  it("defaults to the first listed tab", () => {
    expect(pickAboutTab(data, null)).toBe("artist");
  });

  it("keeps the user's pick while it exists, and falls back when it doesn't", () => {
    expect(pickAboutTab(data, "album")).toBe("album");
    expect(pickAboutTab(data, "song")).toBe("artist");
  });

  it("has nothing to pick when there are no tabs", () => {
    expect(pickAboutTab({ tabs: [], pending: true }, null)).toBeNull();
  });
});
