import { describe, it, expect } from "vitest";
import { cycleMiniWidth } from "../hooks/useMiniMode";

describe("cycleMiniWidth", () => {
  it("returns medium when current is small", () => {
    expect(cycleMiniWidth("small")).toBe("medium");
  });

  it("returns large when current is medium", () => {
    expect(cycleMiniWidth("medium")).toBe("large");
  });

  it("returns small when current is large", () => {
    expect(cycleMiniWidth("large")).toBe("small");
  });
});
