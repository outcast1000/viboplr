import { describe, expect, it } from "vitest";
import { CUE_STYLES, cueStylesFor } from "../utils/cueStyles";
import type { CueContextLyrics, CueContextProse } from "../utils/cueContext";

const synced: CueContextLyrics = { kind: "synced", lines: [{ at: 12, text: "a line" }] };
const plain: CueContextLyrics = { kind: "plain", text: "a line" };
const songStory: CueContextProse = { about: "song", typeId: "song_bio", name: "Song Bio", text: "Written in 1989." };
const artistBio: CueContextProse = { about: "artist", typeId: "artist_bio", name: "About", text: "A band." };

const byId = (offers: ReturnType<typeof cueStylesFor>) => Object.fromEntries(offers.map((o) => [o.id, o]));

describe("cue style catalogue", () => {
  it("has unique ids and a recipe, pitch and valid mode for each", () => {
    const ids = CUE_STYLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of CUE_STYLES) {
      expect(["cards", "clip"]).toContain(s.mode);
      expect(s.pitch.length).toBeGreaterThan(20);
      expect(s.recipe.length).toBeGreaterThan(100);
      expect(s.needs.some((n) => s.prefers.includes(n))).toBe(false);
    }
  });
});

describe("cueStylesFor", () => {
  it("offers everything for a song with synced lyrics, a story and photos", () => {
    const offers = cueStylesFor({ lyrics: synced, prose: [songStory, artistBio], imageCount: 3 });
    expect(offers.every((o) => o.fits)).toBe(true);
    expect(offers.every((o) => o.missing.length === 0)).toBe(true);
    expect(offers.map((o) => o.id)).toEqual(CUE_STYLES.map((s) => s.id));
  });

  it("puts fitting styles first and names what the rest lack", () => {
    const offers = cueStylesFor({ lyrics: plain, prose: [artistBio], imageCount: 0 });
    const s = byId(offers);
    // Synced lyrics are a hard need for every clip style here.
    expect(s.storyteller.fits).toBe(false);
    expect(s.storyteller.missing).toEqual(["synced lyrics"]);
    expect(s["lyric-video"].fits).toBe(false);
    // Annotated needs a song-level story, not just an artist bio.
    expect(s.annotated.fits).toBe(false);
    expect(s.annotated.missing).toEqual(["a song story or meaning"]);
    // Trivia fits on any text, and says photos would make it richer.
    expect(s["pop-up-trivia"].fits).toBe(true);
    expect(s["pop-up-trivia"].missing).toEqual(["photos"]);
    const firstMisfit = offers.findIndex((o) => !o.fits);
    expect(offers.slice(firstMisfit).every((o) => !o.fits)).toBe(true);
  });

  it("offers nothing that needs text for a song with nothing written about it", () => {
    const s = byId(cueStylesFor({ lyrics: synced, prose: [], imageCount: 0 }));
    expect(s["lyric-video"].fits).toBe(true);
    expect(s.translation.fits).toBe(true);
    expect(s.storyteller.fits).toBe(false);
    expect(s["liner-notes"].fits).toBe(false);
  });

  it("does not count an empty synced block as synced lyrics", () => {
    const s = byId(cueStylesFor({ lyrics: { kind: "synced", lines: [] }, prose: [songStory], imageCount: 0 }));
    expect(s["lyric-video"].fits).toBe(false);
    expect(s.annotated.fits).toBe(true); // any lyrics will do there
  });
});
