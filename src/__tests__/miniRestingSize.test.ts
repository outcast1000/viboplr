import { describe, it, expect } from "vitest";
import { cycleRestingSize } from "../hooks/useMiniMode";

describe("cycleRestingSize", () => {
  it("returns compact when current is normal", () => {
    expect(cycleRestingSize("normal")).toBe("compact");
  });

  it("returns normal when current is compact", () => {
    expect(cycleRestingSize("compact")).toBe("normal");
  });
});
