import { describe, it, expect } from "vitest";
import { normalizeTrackTitle, placeMissingTracks, placeMissingRanked, sortProviderRows } from "../utils/missingTracks";

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

describe("placeMissingRanked", () => {
  const lib = rows("Joga", "Hunter");          // displayed order
  const top = rows("Army of Me", "Joga", "Isobel", "Hunter");
  const topValues = [900, 800, 300, 100];

  it("appends missing top songs after the library rows, in rank order, when not sorted by popularity", () => {
    expect(placeMissingRanked(lib, [800, 100], top, topValues, null)).toEqual([
      { providerIndex: 0, before: 2 },
      { providerIndex: 2, before: 2 },
    ]);
  });

  it("slots them in by value when the list is sorted by popularity, descending", () => {
    // Library sorted desc: Joga 800, Hunter 100. Army of Me 900 leads; Isobel 300 sits between.
    expect(placeMissingRanked(lib, [800, 100], top, topValues, "desc")).toEqual([
      { providerIndex: 0, before: 0 },
      { providerIndex: 2, before: 1 },
    ]);
  });

  it("slots them in by value ascending, after equal library values", () => {
    // Library sorted asc: Hunter 100, Joga 800.
    const out = placeMissingRanked(rows("Hunter", "Joga"), [100, 800], rows("Hunter", "Joga", "B-side", "Army of Me"), [100, 800, 100, 900], "asc");
    expect(out).toEqual([
      { providerIndex: 2, before: 1 },
      { providerIndex: 3, before: 2 },
    ]);
  });

  it("puts valued missing rows above library rows with no popularity at all", () => {
    expect(placeMissingRanked(rows("Rare"), [0], rows("Hit"), [500], "desc")).toEqual([{ providerIndex: 0, before: 0 }]);
  });
});

describe("sortProviderRows", () => {
  const prow = (title: string, number: number, popularity?: number) =>
    ({ track: { title, artist_name: "Björk" }, number, popularity, before: 0 });
  const album = [prow("Hunter", 1, 300), prow("Jóga", 2, 900), prow("Unravel", 3), prow("Bachelorette", 4, 900)];
  const titles = (rs: Array<{ track: { title: string } }>) => rs.map(r => r.track.title);

  it("keeps album order with no sort, or a column a provider row can't fill", () => {
    expect(sortProviderRows(album, null, "asc")).toBe(album);
    expect(sortProviderRows(album, "duration", "desc")).toBe(album);
  });

  it("sorts by title and by # in either direction", () => {
    expect(titles(sortProviderRows(album, "title", "asc"))).toEqual(["Bachelorette", "Hunter", "Jóga", "Unravel"]);
    expect(titles(sortProviderRows(album, "num", "desc"))).toEqual(["Bachelorette", "Unravel", "Jóga", "Hunter"]);
  });

  it("sorts by popularity, missing values as zero, ties in album order", () => {
    expect(titles(sortProviderRows(album, "popularity", "desc"))).toEqual(["Jóga", "Bachelorette", "Hunter", "Unravel"]);
  });

  it("does not mutate its input", () => {
    sortProviderRows(album, "title", "asc");
    expect(titles(album)).toEqual(["Hunter", "Jóga", "Unravel", "Bachelorette"]);
  });
});
