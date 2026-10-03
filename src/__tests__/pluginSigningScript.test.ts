import { readFileSync, mkdtempSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs publishing script, no types
import { payload, verifyDir, verifySignature, TRUSTED_PLUGIN_KEYS } from "../../scripts/plugin-signing.mjs";

// The same fixture plugin_signing.rs tests against, signed with a throwaway
// test key — so the publishing script and the app agree on payload AND on what
// verifies.
const FIX = join(__dirname, "../../src-tauri/tests/fixtures/plugin-signing");
const TEST_KEY = readFileSync(join(FIX, "test.key.pub"), "utf8").trim();
const OTHER_KEY = readFileSync(join(FIX, "other.key.pub"), "utf8").trim();

describe("plugin-signing.mjs", () => {
  it("builds the payload the Rust verifier pins", () => {
    const p = payload(readFileSync(join(FIX, "plugin/manifest.json")), readFileSync(join(FIX, "plugin/index.js")));
    expect(p).toBe(readFileSync(join(FIX, "plugin.payload.txt"), "utf8"));
  });

  it("verifies the fixture signature with its key and refuses another key", () => {
    expect(verifyDir(join(FIX, "plugin"), [TEST_KEY])).toBe(true);
    expect(verifyDir(join(FIX, "plugin"), [OTHER_KEY])).toBe(false);
  });

  it("refuses the fixture against the real trusted keys (it was signed by the test key)", () => {
    expect(verifyDir(join(FIX, "plugin"))).toBe(false);
  });

  it("refuses changed code", () => {
    const dir = mkdtempSync(join(tmpdir(), "plugin-sign-test-"));
    for (const f of ["manifest.json", "signature.sig"]) copyFileSync(join(FIX, "plugin", f), join(dir, f));
    writeFileSync(join(dir, "index.js"), readFileSync(join(FIX, "plugin/index.js"), "utf8") + "\n// injected\n");
    expect(verifyDir(dir, [TEST_KEY])).toBe(false);
  });

  it("trusts exactly the keys the app trusts", () => {
    const rust = readFileSync(join(__dirname, "../../src-tauri/src/plugin_signing.rs"), "utf8");
    const block = /TRUSTED_PLUGIN_KEYS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust)?.[1] ?? "";
    const rustKeys = [...block.matchAll(/"([A-Za-z0-9+/=]+)"/g)].map((m) => m[1]);
    expect(rustKeys.length).toBeGreaterThan(0);
    expect([...TRUSTED_PLUGIN_KEYS].sort()).toEqual(rustKeys.sort());
  });

  it("treats a malformed signature as a no at the directory level", () => {
    expect(() => verifySignature("x", "bm90IGEgc2ln", TEST_KEY)).toThrow();
    const dir = mkdtempSync(join(tmpdir(), "plugin-sign-test-"));
    for (const f of ["manifest.json", "index.js"]) copyFileSync(join(FIX, "plugin", f), join(dir, f));
    writeFileSync(join(dir, "signature.sig"), "bm90IGEgc2ln\n");
    expect(verifyDir(dir, [TEST_KEY])).toBe(false);
  });
});
