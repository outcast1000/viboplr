import { describe, it, expect } from "vitest";
import { cycleRestingSize } from "../hooks/useMiniMode";

describe("cycleRestingSize", () => {
  it("returns ultra when current is compact", () => {
    expect(cycleRestingSize("compact")).toBe("ultra");
  });

  it("returns compact when current is ultra", () => {
    expect(cycleRestingSize("ultra")).toBe("compact");
  });
});
