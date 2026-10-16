import { describe, it, expect } from "vitest";
import {
  coerceWeights,
  DEFAULT_AUTO_CONTINUE_WEIGHTS,
  LIBRARY_PREFETCH_LEAD_SECS,
  pickPluginCandidate,
  pickStrategy,
  PLUGIN_PREFETCH_LEAD_SECS,
  prefetchLeadSecs,
  prefetchStillWanted,
  redistributeWeights,
  STRATEGY_KEYS,
  type AutoContinueWeights,
} from "../utils/autoContinue";
import { trackLikeId } from "../utils/likeReconcile";

const w = (over: Partial<AutoContinueWeights>): AutoContinueWeights => ({
  random: 0, sameArtist: 0, sameTag: 0, mostPlayed: 0, liked: 0, similar: 0, ...over,
});
const sum = (x: AutoContinueWeights) => STRATEGY_KEYS.reduce((s, k) => s + x[k], 0);

describe("pickStrategy (weighted random)", () => {
  const weights = DEFAULT_AUTO_CONTINUE_WEIGHTS;

  it("maps each roll band to its strategy, in slider order", () => {
    expect(pickStrategy(weights, 0)).toBe("random");
    expect(pickStrategy(weights, 39)).toBe("random");
    expect(pickStrategy(weights, 40)).toBe("same_artist");
    expect(pickStrategy(weights, 59)).toBe("same_artist");
    expect(pickStrategy(weights, 60)).toBe("same_tag");
    expect(pickStrategy(weights, 79)).toBe("same_tag");
    expect(pickStrategy(weights, 80)).toBe("most_played");
    expect(pickStrategy(weights, 89)).toBe("most_played");
    expect(pickStrategy(weights, 90)).toBe("liked");
    expect(pickStrategy(weights, 99)).toBe("liked");
  });

  it("never picks the plugin strategy at its default weight of 0", () => {
    for (let roll = 0; roll < 100; roll++) expect(pickStrategy(weights, roll)).not.toBe("similar");
  });

  it("picks the plugin strategy for its share", () => {
    const withSimilar = w({ random: 80, similar: 20 });
    expect(pickStrategy(withSimilar, 79)).toBe("random");
    expect(pickStrategy(withSimilar, 80)).toBe("similar");
    expect(pickStrategy(withSimilar, 99)).toBe("similar");
  });

  it("falls back to random for an out-of-range roll or all-zero weights", () => {
    expect(pickStrategy(weights, 100)).toBe("random");
    expect(pickStrategy(w({}), 0)).toBe("random");
  });

  it("handles a single-strategy weight", () => {
    expect(pickStrategy(w({ sameArtist: 100 }), 50)).toBe("same_artist");
  });
});

describe("coerceWeights", () => {
  it("reads a profile saved before the plugin strategy: same picks, similar at 0", () => {
    const old = { random: 50, sameArtist: 20, sameTag: 10, mostPlayed: 10, liked: 10 };
    expect(coerceWeights(old)).toEqual({ ...old, similar: 0 });
  });

  it("fills missing or junk values from the defaults", () => {
    expect(coerceWeights(null)).toEqual(DEFAULT_AUTO_CONTINUE_WEIGHTS);
    expect(coerceWeights({ random: "x", similar: 250 })).toMatchObject({ random: 40, similar: 100 });
  });
});

describe("redistributeWeights", () => {
  it("keeps the six weights at 100 when one moves", () => {
    const next = redistributeWeights(DEFAULT_AUTO_CONTINUE_WEIGHTS, "similar", 30);
    expect(next.similar).toBe(30);
    expect(sum(next)).toBe(100);
  });

  it("spreads evenly when every other weight is 0, leaving opt-in Similar out", () => {
    const next = redistributeWeights(w({ random: 100 }), "random", 40);
    expect(sum(next)).toBe(100);
    expect(next.sameArtist).toBe(15);
    expect(next.similar).toBe(0);
  });

  it("never lifts a weight off 0 by rounding (the remainder goes to the largest)", () => {
    // Before: the remainder landed on the last key, Similar — 67 − 66 = 1%.
    const next = redistributeWeights(DEFAULT_AUTO_CONTINUE_WEIGHTS, "random", 33);
    expect(next.similar).toBe(0);
    expect(sum(next)).toBe(100);
    for (let v = 0; v <= 100; v++) {
      expect(redistributeWeights(DEFAULT_AUTO_CONTINUE_WEIGHTS, "sameTag", v).similar).toBe(0);
    }
  });

  it("returns the same object when nothing changes", () => {
    const prev = DEFAULT_AUTO_CONTINUE_WEIGHTS;
    expect(redistributeWeights(prev, "random", 40)).toBe(prev);
  });
});

describe("prefetchLeadSecs", () => {
  it("keeps the library's 20s when no plugin can answer", () => {
    expect(prefetchLeadSecs({ hasProviders: false, similarWeight: 50, libraryEmpty: true })).toBe(LIBRARY_PREFETCH_LEAD_SECS);
  });

  it("keeps 20s with a library and the plugin strategy off", () => {
    expect(prefetchLeadSecs({ hasProviders: true, similarWeight: 0, libraryEmpty: false })).toBe(LIBRARY_PREFETCH_LEAD_SECS);
  });

  it("asks early when a plugin will likely answer: no library, or Similar on", () => {
    expect(prefetchLeadSecs({ hasProviders: true, similarWeight: 0, libraryEmpty: true })).toBe(PLUGIN_PREFETCH_LEAD_SECS);
    expect(prefetchLeadSecs({ hasProviders: true, similarWeight: 10, libraryEmpty: false })).toBe(PLUGIN_PREFETCH_LEAD_SECS);
  });
});

describe("prefetchStillWanted", () => {
  const base = { fetchedForKey: "q:1", currentKey: "q:1", hasNext: false, backfillPending: false };

  it("queues a late pick that still continues the playing track", () => {
    expect(prefetchStillWanted(base)).toBe(true);
  });

  it("drops it once playback moved on: another track, something queued after, a session still filling", () => {
    expect(prefetchStillWanted({ ...base, currentKey: "q:9" })).toBe(false); // user started an album
    expect(prefetchStillWanted({ ...base, currentKey: null })).toBe(false); // stopped
    expect(prefetchStillWanted({ ...base, hasNext: true })).toBe(false); // the end-of-queue pick, or a user enqueue
    expect(prefetchStillWanted({ ...base, backfillPending: true })).toBe(false);
  });
});

describe("pickPluginCandidate", () => {
  const none = { recentIds: new Set<string>(), likeStates: [] as number[], formatFilter: null };

  it("takes the first usable suggestion", () => {
    expect(pickPluginCandidate([{ title: "A", artist_name: "X" }, { title: "B" }], none)).toBe(0);
  });

  it("skips untitled, recently played and disliked suggestions", () => {
    const recentIds = new Set([trackLikeId("Jóga", "Björk")]);
    const candidates = [
      { title: "  " },
      { title: "joga", artist_name: "bjork" }, // same song, folded
      { title: "Hated", artist_name: "Y" },
      { title: "Fresh", artist_name: "Z" },
    ];
    expect(pickPluginCandidate(candidates, { ...none, recentIds, likeStates: [0, 0, -1, 0] })).toBe(3);
  });

  it("honours Same format: a suggestion that doesn't say video counts as audio", () => {
    const candidates = [{ title: "Song" }, { title: "Clip", kind: "video" as const }];
    expect(pickPluginCandidate(candidates, { ...none, formatFilter: "video" })).toBe(1);
    expect(pickPluginCandidate(candidates, { ...none, formatFilter: "audio" })).toBe(0);
    expect(pickPluginCandidate([{ title: "Song" }], { ...none, formatFilter: "video" })).toBeNull();
  });
});
