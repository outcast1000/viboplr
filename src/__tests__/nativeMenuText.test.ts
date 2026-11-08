import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/menu", () => ({}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { menuText } from "../nativeMenu";

// Native menu text treats a single `&` as a mnemonic marker (muda 0.20: macOS
// strips it, Windows underlines the next letter); `&&` is a literal `&`.
describe("menuText", () => {
  it("doubles every & so names with one show it", () => {
    expect(menuText("Back to: Simon & Garfunkel")).toBe("Back to: Simon && Garfunkel");
    expect(menuText("R&B & Soul")).toBe("R&&B && Soul");
  });

  it("leaves text without & alone", () => {
    expect(menuText("Load playlist…")).toBe("Load playlist…");
    expect(menuText("")).toBe("");
  });
});
