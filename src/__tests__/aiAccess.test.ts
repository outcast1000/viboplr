import { describe, expect, it } from "vitest";
import { aiAccessLevel, FULL_SCOPES, LOW_SCOPES, scopesForLevel } from "../utils/aiAccess";

describe("aiAccessLevel", () => {
  it("is off whenever the control API is off, whatever the scopes say", () => {
    expect(aiAccessLevel(false, FULL_SCOPES)).toBe("off");
    expect(aiAccessLevel(false, LOW_SCOPES)).toBe("off");
  });

  it("derives low / full / custom from the scopes", () => {
    expect(aiAccessLevel(true, LOW_SCOPES)).toBe("low");
    expect(aiAccessLevel(true, FULL_SCOPES)).toBe("full");
    expect(aiAccessLevel(true, { ...LOW_SCOPES, downloads: true })).toBe("custom");
    expect(aiAccessLevel(true, { ...FULL_SCOPES, uiInput: false })).toBe("custom");
  });
});

describe("scopesForLevel", () => {
  it("writes the presets and leaves off / custom alone", () => {
    expect(scopesForLevel("low")).toEqual(LOW_SCOPES);
    expect(scopesForLevel("full")).toEqual(FULL_SCOPES);
    expect(scopesForLevel("off")).toBeNull();
    expect(scopesForLevel("custom")).toBeNull();
  });
});
