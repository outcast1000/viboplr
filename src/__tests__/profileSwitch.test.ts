import { describe, it, expect } from "vitest";
import { decideSwitchAction } from "../utils/profileSwitch";

describe("decideSwitchAction", () => {
  it("ignores a request while a switch is already in flight", () => {
    expect(decideSwitchAction(true, true)).toBe("ignore");
    expect(decideSwitchAction(false, true)).toBe("ignore");
  });

  it("switches without flushing before restore completes", () => {
    // Flushing pre-restore would overwrite the saved queue with the empty default.
    expect(decideSwitchAction(false, false)).toBe("switch-without-flush");
  });

  it("flushes both writers then switches in the normal case", () => {
    expect(decideSwitchAction(true, false)).toBe("flush-then-switch");
  });
});
