// Bundled plugins maintained in their own repo (Last.fm) ship as a pinned copy
// of a release, files unchanged (scripts/sync-bundled-plugins.mjs). These
// checks are what make "never edit the copy" enforceable: a hand edit fails the
// lock hashes AND the signature, so a fix has to go through the plugin's repo.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error — plain .mjs dev script, no type declarations
import { checkBundledCopy, compareVersions, parseLatestTag, updateUrlFor } from "../../scripts/lib/bundledPlugins.mjs";
// @ts-expect-error — plain .mjs dev script, no type declarations
import { verifyDir } from "../../scripts/plugin-signing.mjs";

type LockEntry = { repo: string; asset: string; version: string; files: Record<string, string> };
const lock = JSON.parse(readFileSync(resolve(process.cwd(), "scripts/bundled-plugins.lock.json"), "utf8")) as {
  plugins: Record<string, LockEntry>;
};

describe.each(Object.entries(lock.plugins))("bundled plugin %s", (id, entry) => {
  const dir = resolve(process.cwd(), "src-tauri/plugins", id);

  it("is exactly the pinned release's files", () => {
    expect(checkBundledCopy(dir, entry)).toEqual([]);
  });

  it("carries a signature by the trusted plugin key", () => {
    expect(verifyDir(dir)).toBe(true);
  });

  it("declares the updateUrl that lets newer releases reach users", () => {
    const manifest = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8"));
    expect(manifest.updateUrl).toBe(updateUrlFor(entry));
  });
});

describe("bundled plugin helpers", () => {
  it("reads the version off a releases/latest redirect", () => {
    expect(parseLatestTag("https://github.com/outcast1000/viboplr-lastfm/releases/tag/v1.7.0")).toBe("1.7.0");
    expect(parseLatestTag("https://github.com/outcast1000/viboplr-lastfm/releases")).toBeNull();
    expect(parseLatestTag(null)).toBeNull();
  });

  it("orders versions numerically", () => {
    expect(compareVersions("1.7.0", "1.10.0")).toBe(-1);
    expect(compareVersions("1.7.0", "1.7.0")).toBe(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
  });
});
