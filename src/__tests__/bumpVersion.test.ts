import { describe, it, expect } from "vitest";
import { nextVersion } from "../../scripts/lib/version.mjs";

describe("nextVersion", () => {
  it("bumps patch for a stable version", () => {
    expect(nextVersion("0.9.151")).toBe("0.9.152");
  });

  it("bumps the prerelease counter for a beta", () => {
    expect(nextVersion("0.9.151-beta.1")).toBe("0.9.151-beta.2");
  });

  it("handles multi-digit prerelease counters", () => {
    expect(nextVersion("0.9.151-beta.10")).toBe("0.9.151-beta.11");
  });

  it("starts a counter on a bare prerelease suffix", () => {
    expect(nextVersion("0.9.151-beta")).toBe("0.9.151-beta.1");
  });

  it("does not touch major/minor", () => {
    expect(nextVersion("1.10.0")).toBe("1.10.1");
  });

  it("throws on unrecognized versions", () => {
    expect(() => nextVersion("garbage")).toThrow(/Unrecognized version/);
    expect(() => nextVersion("0.9")).toThrow(/Unrecognized version/);
  });
});
