import { describe, it, expect } from "vitest";
import {
  PROFILE_PRESETS,
  ONBOARDING_PROFILES,
  seedProfileShelfVisibility,
} from "../components/onboardingSteps";
import { BUILTIN_SHELF_DESCRIPTORS, isShelfVisible } from "../hooks/useHome";

const VIDEO_SHELF = "builtin:recently-added-tracks";

describe("profileShelves", () => {
  it("names only shelves that actually exist", () => {
    // The ids in PROFILE_PRESETS are literals (onboardingSteps.ts must not pull
    // in useHome's store/invoke imports), so this is what stops a renamed shelf
    // from turning the seed into a silent no-op.
    const known = new Set(BUILTIN_SHELF_DESCRIPTORS.map((d) => d.id));
    for (const p of ONBOARDING_PROFILES) {
      for (const id of PROFILE_PRESETS[p].profileShelves) {
        expect(known, `profile "${p}" names unknown shelf "${id}"`).toContain(id);
      }
    }
  });

  it("only seeds shelves that are off by default — seeding a visible one is a no-op", () => {
    // If a seeded shelf were already defaultVisible, the whole mechanism would
    // be dead weight for that profile.
    for (const p of ONBOARDING_PROFILES) {
      for (const id of PROFILE_PRESETS[p].profileShelves) {
        const d = BUILTIN_SHELF_DESCRIPTORS.find((x) => x.id === id)!;
        expect(d.defaultVisible, `"${id}" is already visible by default`).toBe(false);
      }
    }
  });

  it("gives the video profile the one shelf that can surface videos", () => {
    // Videos carry no album_id, so "Recently added albums" (visible by default)
    // can never show one. This track-based shelf is the only built-in that can.
    expect(PROFILE_PRESETS.video.profileShelves).toEqual([VIDEO_SHELF]);
  });

  it("leaves the other profiles alone", () => {
    expect(PROFILE_PRESETS.normal.profileShelves).toEqual([]);
    expect(PROFILE_PRESETS.streaming.profileShelves).toEqual([]);
    expect(PROFILE_PRESETS.server.profileShelves).toEqual([]);
  });
});

describe("seedProfileShelfVisibility", () => {
  it("switches the shelf on when the user has no opinion yet", () => {
    expect(seedProfileShelfVisibility("video", {})).toEqual({ [VIDEO_SHELF]: true });
  });

  it("returns null when there is nothing to fill", () => {
    expect(seedProfileShelfVisibility("normal", {})).toBeNull();
    expect(seedProfileShelfVisibility("streaming", {})).toBeNull();
    expect(seedProfileShelfVisibility("server", {})).toBeNull();
  });

  it("never overrides a shelf the user switched off", () => {
    // The wizard is re-runnable from Settings. Re-asserting the profile's
    // shelves on each run would silently undo a deliberate toggle.
    expect(seedProfileShelfVisibility("video", { [VIDEO_SHELF]: false })).toBeNull();
  });

  it("returns null when the user already switched it on", () => {
    expect(seedProfileShelfVisibility("video", { [VIDEO_SHELF]: true })).toBeNull();
  });

  it("leaves other shelves untouched", () => {
    const before = { "builtin:liked-artists": false, "builtin:recently-played": true };
    const after = seedProfileShelfVisibility("video", before);
    expect(after).toEqual({ ...before, [VIDEO_SHELF]: true });
    // Pure — the caller's object is not mutated.
    expect(before).not.toHaveProperty(VIDEO_SHELF);
  });

  it("actually makes the shelf visible to the renderer", () => {
    // Ties the seed to the consumer: a written key must survive isShelfVisible.
    expect(isShelfVisible(VIDEO_SHELF, {})).toBe(false);
    const seeded = seedProfileShelfVisibility("video", {})!;
    expect(isShelfVisible(VIDEO_SHELF, seeded)).toBe(true);
  });
});
