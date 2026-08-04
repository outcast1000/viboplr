import { describe, it, expect, vi } from "vitest";

// useDependencies imports Tauri's invoke at module level; stub it so the pure
// signature helper loads without the Tauri runtime.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { pluginDepSignature, type PluginDepDeclaration } from "../hooks/useDependencies";

const decl = (over: Partial<PluginDepDeclaration> = {}): PluginDepDeclaration => ({
  name: "yt-dlp",
  pluginName: "yt-dlp",
  reason: "search and resolve streams",
  required: true,
  ...over,
});

describe("pluginDepSignature", () => {
  it("ignores declaration order", () => {
    const a = [decl(), decl({ name: "ffmpeg", required: false })];
    expect(pluginDepSignature(a)).toBe(pluginDepSignature([...a].reverse()));
  });

  it("ignores the reason text — it does not affect which deps are needed", () => {
    expect(pluginDepSignature([decl()])).toBe(pluginDepSignature([decl({ reason: "other" })]));
  });

  it("changes when a plugin's dependency appears", () => {
    // The first-run case: the wizard installs the yt-dlp plugin, so its declared
    // binaries have to be re-probed to build the missing-dependency step.
    const before: PluginDepDeclaration[] = [];
    const after = [decl()];
    expect(pluginDepSignature(before)).not.toBe(pluginDepSignature(after));
  });

  it("changes when the same binary flips required", () => {
    expect(pluginDepSignature([decl({ required: true })])).not.toBe(
      pluginDepSignature([decl({ required: false })]),
    );
  });

  it("changes when a second plugin declares the same binary", () => {
    // Both consumers must show up in the row's "needed by" list.
    expect(pluginDepSignature([decl()])).not.toBe(
      pluginDepSignature([decl(), decl({ pluginName: "TIDAL" })]),
    );
  });

  it("is empty for no declarations", () => {
    expect(pluginDepSignature([])).toBe("");
  });
});
