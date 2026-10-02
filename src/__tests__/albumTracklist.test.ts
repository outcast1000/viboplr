import { describe, it, expect } from "vitest";
import { normalizeTrackTitle, placeMissingTracks } from "../utils/albumTracklist";

const rows = (...titles: string[]) => titles.map(title => ({ title }));

describe("normalizeTrackTitle", () => {
  it("folds case, accents, parentheticals and punctuation", () => {
    expect(normalizeTrackTitle("Jóga (Remastered 2011)")).toBe(normalizeTrackTitle("joga"));
    expect(normalizeTrackTitle("All Is Full of Love!")).toBe("allisfulloflove");
  });
});

describe("placeMissingTracks", () => {
  it("places each missing track after the nearest earlier owned one", () => {
    // Album: Hunter, Joga, Unravel, Bachelorette. Owned: Hunter, Bachelorette.
    const out = placeMissingTracks(rows("Hunter", "Bachelorette"), rows("Hunter", "Jóga", "Unravel", "Bachelorette"), true);
    expect(out).toEqual([
      { providerIndex: 1, before: 1 },
      { providerIndex: 2, before: 1 },
    ]);
  });

  it("puts missing opening tracks before the first owned one", () => {
    const out = placeMissingTracks(rows("Joga"), rows("Hunter", "Joga"), true);
    expect(out).toEqual([{ providerIndex: 0, before: 0 }]);
  });

  it("matches across editions' parentheticals and accents", () => {
    expect(placeMissingTracks(rows("Joga (Remastered)"), rows("Jóga"), true)).toEqual([]);
  });

  it("matches one-to-one, so a repeated title claims a second library row", () => {
    const out = placeMissingTracks(rows("Intro", "Song"), rows("Intro", "Song", "Intro"), true);
    expect(out).toEqual([{ providerIndex: 2, before: 2 }]);
  });

  it("never matches a title that normalizes to nothing", () => {
    expect(placeMissingTracks(rows("…"), rows("!!!"), true)).toEqual([{ providerIndex: 0, before: 1 }]);
  });

  it("appends everything after the library rows when the list is sorted by a column", () => {
    const out = placeMissingTracks(rows("Hunter", "Bachelorette"), rows("Hunter", "Joga", "Bachelorette"), false);
    expect(out).toEqual([{ providerIndex: 1, before: 2 }]);
  });

  it("appends when nothing is owned at all (a different edition)", () => {
    const out = placeMissingTracks(rows("Other"), rows("A", "B"), true);
    expect(out).toEqual([{ providerIndex: 0, before: 1 }, { providerIndex: 1, before: 1 }]);
  });
});
