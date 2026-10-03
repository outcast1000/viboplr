import { describe, it, expect } from "vitest";
import { pickRadioSeed, seedCandidates, seedWeights, type SeedCandidate } from "../utils/radioSeed";
import type { QueueTrack, Track } from "../types";

const lib = (id: number, title: string, liked = 0) => ({ id, title, liked, artist_name: "A", album_title: "X" }) as unknown as Track;
const ext = (title: string, liked = 0) => ({ title, liked, artist_name: "A", album_title: "X", key: `q:${title}` }) as unknown as QueueTrack;
const titles = (cs: SeedCandidate[]) => cs.map(c => c.seed.track.title);

describe("seedWeights", () => {
  it("weighs by popularity share: the top track 5x one with no count", () => {
    const cs = seedCandidates([lib(1, "Hit"), lib(2, "Deep cut")], { 1: 1000 }, [{ track: ext("Half"), popularity: 500 }]);
    expect(titles(cs)).toEqual(["Hit", "Deep cut", "Half"]);
    expect(seedWeights(cs)).toEqual([5, 1, 3]);
  });

  it("falls back to likes when there is no popularity at all (a tag page)", () => {
    const cs = seedCandidates([lib(1, "Liked", 1), lib(2, "Plain")], {}, []);
    expect(seedWeights(cs)).toEqual([3, 1]);
  });

  it("never picks a disliked track", () => {
    const cs = seedCandidates([lib(1, "Nope", -1), lib(2, "Ok")], { 1: 9999 }, []);
    expect(seedWeights(cs)[0]).toBe(0);
  });
});

describe("pickRadioSeed", () => {
  const cs = seedCandidates([lib(1, "Hit"), lib(2, "Deep cut")], { 1: 1000 }, []); // weights 5, 1 (total 6)

  it("maps the random draw onto the weights", () => {
    expect(pickRadioSeed(cs, () => 0)?.track.title).toBe("Hit");
    expect(pickRadioSeed(cs, () => 4.9 / 6)?.track.title).toBe("Hit");
    expect(pickRadioSeed(cs, () => 5.1 / 6)?.track.title).toBe("Deep cut");
    expect(pickRadioSeed(cs, () => 0.999999)?.track.title).toBe("Deep cut");
  });

  it("keeps the seed kind, so the page starts it the right way", () => {
    const mixed = seedCandidates([lib(1, "Owned")], {}, [{ track: ext("Missing") }]);
    expect(pickRadioSeed(mixed, () => 0)?.kind).toBe("library");
    expect(pickRadioSeed(mixed, () => 0.99)?.kind).toBe("external");
  });

  it("is null with nothing pickable", () => {
    expect(pickRadioSeed([], () => 0)).toBeNull();
    expect(pickRadioSeed(seedCandidates([lib(1, "Nope", -1)], {}, []), () => 0)).toBeNull();
  });
});
