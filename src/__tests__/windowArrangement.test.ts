import { describe, it, expect } from "vitest";
import { arrangementSignature, toMonitorInfo } from "../utils/windowArrangement";

const builtin = { x: 0, y: 0, width: 2560, height: 1440, scaleFactor: 2 };
const external = { x: -1920, y: -200, width: 1920, height: 1080, scaleFactor: 1 };

describe("arrangementSignature", () => {
  it("formats physical coords plus scale×100", () => {
    expect(arrangementSignature([builtin])).toBe("0,0,2560,1440,200");
  });

  // The exact string below is also asserted by the Rust side
  // (`window_arrangement.rs` → test_signature_matches_the_frontend_fixture) —
  // the two implementations must agree, or the startup restore and the live
  // save would key the same desk setup differently.
  it("sorts monitors so enumeration order can't change the key", () => {
    const sig = "-1920,-200,1920,1080,100|0,0,2560,1440,200";
    expect(arrangementSignature([builtin, external])).toBe(sig);
    expect(arrangementSignature([external, builtin])).toBe(sig);
  });

  it("rounds fractional scale factors to a stable integer", () => {
    // Windows 175% often reports 1.7500000001-style floats.
    expect(arrangementSignature([{ ...builtin, scaleFactor: 1.7500000001 }]))
      .toBe("0,0,2560,1440,175");
  });

  it("distinguishes the same monitor at a different scale", () => {
    expect(arrangementSignature([builtin]))
      .not.toBe(arrangementSignature([{ ...builtin, scaleFactor: 1 }]));
  });

  it("returns an empty string for no monitors", () => {
    expect(arrangementSignature([])).toBe("");
  });
});

describe("toMonitorInfo", () => {
  it("maps the Tauri Monitor shape", () => {
    expect(toMonitorInfo({
      position: { x: 10, y: 20 },
      size: { width: 300, height: 400 },
      scaleFactor: 2,
    })).toEqual({ x: 10, y: 20, width: 300, height: 400, scaleFactor: 2 });
  });
});
