import { describe, expect, it } from "vitest";
import { ENFORCE_SIGNED_MAIN_REALM, mainRealmVerdict } from "../utils/pluginTrust";

const phased = { debugMode: false, enforce: false };
const enforced = { debugMode: false, enforce: true };

describe("mainRealmVerdict", () => {
  it("ignores worker plugins and built-ins, signed or not", () => {
    for (const opts of [phased, enforced]) {
      expect(mainRealmVerdict({ runtime: "worker", signature: "unsigned" }, opts)).toEqual({ allow: true, unverified: false });
      expect(mainRealmVerdict({ builtin: true, signature: "builtin" }, opts)).toEqual({ allow: true, unverified: false });
    }
  });

  it("never gates a worker plugin on its signature — not even a broken one", () => {
    // Worker plugins are bounded by their permissions; signing is only for the
    // main realm. A stray signature.sig in a worker plugin's zip is irrelevant.
    for (const signature of ["unsigned", "invalid", "verified", undefined] as const) {
      for (const opts of [phased, enforced, { debugMode: true, enforce: true }]) {
        expect(mainRealmVerdict({ runtime: "worker", signature }, opts)).toEqual({ allow: true, unverified: false });
      }
    }
  });

  it("lets a verified main-realm plugin run unlabelled", () => {
    expect(mainRealmVerdict({ signature: "verified" }, enforced)).toEqual({ allow: true, unverified: false });
  });

  it("refuses a broken signature even during the migration", () => {
    const v = mainRealmVerdict({ signature: "invalid", signatureError: "signature does not verify" }, phased);
    expect(v.allow).toBe(false);
    if (!v.allow) expect(v.reason).toMatch(/signature does not verify/);
  });

  it("refuses a broken signature on a dev folder too", () => {
    expect(mainRealmVerdict({ dev: true, signature: "invalid" }, { debugMode: true, enforce: false }).allow).toBe(false);
  });

  it("runs an unsigned plugin labelled while not enforcing, refuses it once enforcing", () => {
    expect(mainRealmVerdict({ signature: "unsigned" }, phased)).toEqual({ allow: true, unverified: true });
    expect(mainRealmVerdict({ signature: "unsigned" }, enforced).allow).toBe(false);
  });

  it("treats a listing without the field as unsigned, never as verified", () => {
    expect(mainRealmVerdict({}, phased)).toEqual({ allow: true, unverified: true });
    expect(mainRealmVerdict({}, enforced).allow).toBe(false);
  });

  it("lets an unsigned dev folder run in debug mode, labelled, even when enforcing", () => {
    expect(mainRealmVerdict({ dev: true, signature: "unsigned" }, { debugMode: true, enforce: true })).toEqual({
      allow: true,
      unverified: true,
    });
    expect(mainRealmVerdict({ dev: true, signature: "unsigned" }, { debugMode: false, enforce: true }).allow).toBe(false);
  });

  it("ships with enforcement off for the migration window", () => {
    // Flip deliberately, once the gallery's non-visualizer plugins ship on the
    // worker runtime — doing it earlier stops them working for users.
    expect(ENFORCE_SIGNED_MAIN_REALM).toBe(false);
  });
});
