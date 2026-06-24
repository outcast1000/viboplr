import { describe, it, expect } from "vitest";
import { buildStarterSkin, skinSubmissionUrl, validateSkin } from "../skinUtils";
import { SKIN_COLOR_KEYS } from "../types/skin";

describe("buildStarterSkin", () => {
  it("produces a skin that passes validateSkin with all 18 color keys", () => {
    const s = buildStarterSkin();
    const v = validateSkin(s);
    expect(v.ok).toBe(true);
    expect(Object.keys(s.colors)).toHaveLength(SKIN_COLOR_KEYS.length);
    for (const k of SKIN_COLOR_KEYS) {
      expect(typeof s.colors[k]).toBe("string");
    }
  });

  it("returns a fresh colors object each call so edits don't bleed across skins", () => {
    const a = buildStarterSkin();
    const b = buildStarterSkin();
    a.colors["accent"] = "#000000";
    expect(b.colors["accent"]).not.toBe("#000000");
  });
});

describe("skinSubmissionUrl", () => {
  it("pre-fills the skin-json field for a normal-sized skin", () => {
    const json = JSON.stringify(buildStarterSkin());
    const url = skinSubmissionUrl(json);
    expect(url).toContain("template=submit-skin.yml");
    expect(url).toContain("skin-json=");
    const encoded = url.split("skin-json=")[1];
    expect(JSON.parse(decodeURIComponent(encoded))).toMatchObject({ name: "My Skin" });
  });

  it("omits the pre-fill when the JSON is too large for a URL (clipboard fallback)", () => {
    const big = JSON.stringify({
      ...buildStarterSkin(),
      customCSS: "/*" + "x".repeat(9000) + "*/",
    });
    const url = skinSubmissionUrl(big);
    expect(url).toContain("template=submit-skin.yml");
    expect(url).not.toContain("skin-json=");
  });
});
