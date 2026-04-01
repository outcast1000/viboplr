// src/__tests__/skinUtils.test.ts
import { describe, it, expect } from "vitest";
import { validateSkin, generateSkinCSS, sanitizeCustomCSS, slugifySkinName } from "../skinUtils";

describe("validateSkin", () => {
  const validSkin = {
    name: "Test", author: "dev", version: "1.0.0", type: "dark" as const,
    colors: {
      "bg-primary": "#1a1a2e", "bg-secondary": "#16213e", "bg-tertiary": "#1e2a4a",
      "bg-surface": "#0f3460", "bg-hover": "#1a3a6e", "text-primary": "#e0e0e0",
      "text-secondary": "#a0a0b0", "text-tertiary": "#707080",
      "accent": "#53a8ff", "accent-dim": "#3a7bd5", "border": "#2a2a4a",
      "now-playing-bg": "#0d1b2a", "success": "#4caf50", "error": "#f44336",
      "warning": "#ff9500",
    },
  };

  it("accepts a valid skin", () => {
    expect(validateSkin(validSkin)).toEqual({ ok: true });
  });

  it("rejects missing name", () => {
    const skin = { ...validSkin, name: "" };
    expect(validateSkin(skin).ok).toBe(false);
  });

  it("rejects invalid type", () => {
    const skin = { ...validSkin, type: "blue" };
    expect(validateSkin(skin as any).ok).toBe(false);
  });

  it("rejects invalid hex color", () => {
    const skin = { ...validSkin, colors: { ...validSkin.colors, accent: "red" } };
    expect(validateSkin(skin).ok).toBe(false);
  });

  it("accepts 3-digit hex", () => {
    const skin = { ...validSkin, colors: { ...validSkin.colors, accent: "#f00" } };
    expect(validateSkin(skin)).toEqual({ ok: true });
  });

  it("rejects customCSS over 10KB", () => {
    const skin = { ...validSkin, customCSS: "a".repeat(10241) };
    expect(validateSkin(skin).ok).toBe(false);
  });
});

describe("sanitizeCustomCSS", () => {
  it("strips url()", () => {
    expect(sanitizeCustomCSS("background: url(http://evil.com)")).toBe("background: ");
  });

  it("strips @import", () => {
    expect(sanitizeCustomCSS("@import 'evil.css'; color: red;")).toBe(" color: red;");
  });

  it("strips expression()", () => {
    expect(sanitizeCustomCSS("width: expression(alert(1))")).toBe("width: ");
  });

  it("strips javascript:", () => {
    expect(sanitizeCustomCSS("background: javascript:alert(1)")).toBe("background: ");
  });

  it("passes clean CSS through", () => {
    expect(sanitizeCustomCSS(".foo { color: #f00; }")).toBe(".foo { color: #f00; }");
  });
});

describe("generateSkinCSS", () => {
  it("generates root variables from colors", () => {
    const css = generateSkinCSS({
      "bg-primary": "#111",
      accent: "#f00",
    } as any);
    expect(css).toContain("--bg-primary: #111");
    expect(css).toContain("--accent: #f00");
  });

  it("appends sanitized customCSS", () => {
    const css = generateSkinCSS(
      { "bg-primary": "#111" } as any,
      ".custom { padding: 0; }"
    );
    expect(css).toContain("--bg-primary: #111");
    expect(css).toContain(".custom { padding: 0; }");
  });
});

describe("slugifySkinName", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugifySkinName("Arctic Light")).toBe("arctic-light");
  });

  it("strips non-alphanumeric characters", () => {
    expect(slugifySkinName("My Theme! (v2)")).toBe("my-theme-v2");
  });

  it("collapses multiple hyphens", () => {
    expect(slugifySkinName("foo  --  bar")).toBe("foo-bar");
  });
});
