import { describe, it, expect } from "vitest";
import {
  PROFILE_PRESETS,
  ONBOARDING_PROFILES,
  seedProfileShelfVisibility,
} from "../components/onboardingSteps";
import { BUILTIN_SHELF_DESCRIPTORS, isShelfVisible } from "../hooks/useHome";

const LIKED_SHELF = "builtin:recently-liked";
const ARTISTS_SHELF = "builtin:most-played-artists-30d";

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

  it("gives the no-collection profile the shelves that fill without a library", () => {
    // Likes are metadata-keyed and history is name-keyed, so both work for a
    // setup whose every track comes from a plugin.
    expect(PROFILE_PRESETS.streaming.profileShelves).toEqual([LIKED_SHELF, ARTISTS_SHELF]);
  });

  it("seeds nothing for own music — it is every non-wizard user's profile too", () => {
    // normalizeProfile(undefined) is "normal", so a shelf here would be
    // switched on for everyone who never ran the wizard.
    expect(PROFILE_PRESETS.normal.profileShelves).toEqual([]);
  });
});

describe("seedProfileShelfVisibility", () => {
  it("switches the shelves on when the user has no opinion yet", () => {
    expect(seedProfileShelfVisibility("streaming", {})).toEqual({
      [LIKED_SHELF]: true,
      [ARTISTS_SHELF]: true,
    });
  });

  it("returns null when there is nothing to fill", () => {
    expect(seedProfileShelfVisibility("normal", {})).toBeNull();
  });

  it("fills only the shelves still unset", () => {
    expect(seedProfileShelfVisibility("streaming", { [LIKED_SHELF]: false })).toEqual({
      [LIKED_SHELF]: false,
      [ARTISTS_SHELF]: true,
    });
  });

  it("never overrides a shelf the user set either way", () => {
    // The wizard is re-runnable from Settings. Re-asserting the profile's
    // shelves on each run would silently undo a deliberate toggle.
    expect(seedProfileShelfVisibility("streaming", { [LIKED_SHELF]: false, [ARTISTS_SHELF]: false })).toBeNull();
    expect(seedProfileShelfVisibility("streaming", { [LIKED_SHELF]: true, [ARTISTS_SHELF]: true })).toBeNull();
  });

  it("leaves other shelves untouched", () => {
    const before = { "builtin:liked-artists": false, "builtin:recently-played": true };
    const after = seedProfileShelfVisibility("streaming", before);
    expect(after).toEqual({ ...before, [LIKED_SHELF]: true, [ARTISTS_SHELF]: true });
    // Pure — the caller's object is not mutated.
    expect(before).not.toHaveProperty(LIKED_SHELF);
  });

  it("actually makes the shelf visible to the renderer", () => {
    // Ties the seed to the consumer: a written key must survive isShelfVisible.
    expect(isShelfVisible(LIKED_SHELF, {})).toBe(false);
    const seeded = seedProfileShelfVisibility("streaming", {})!;
    expect(isShelfVisible(LIKED_SHELF, seeded)).toBe(true);
  });
});
