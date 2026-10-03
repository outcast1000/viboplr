import { describe, expect, it } from "vitest";
import { deleteIfSame } from "../utils/registryOps";

describe("deleteIfSame", () => {
  it("removes the entry its registration made", () => {
    const m = new Map<string, object>();
    const a = { id: 1 };
    m.set("p:x", a);
    expect(deleteIfSame(m, "p:x", a)).toBe(true);
    expect(m.has("p:x")).toBe(false);
  });

  it("leaves a re-registration alone when the old unsubscriber runs late", () => {
    // The worker-runtime order: register A, register B (same id), then A's
    // unsubscriber lands a microtask later. B must survive.
    const m = new Map<string, object>();
    const a = { id: "first" };
    const b = { id: "second" };
    m.set("p:x", a);
    m.set("p:x", b);
    expect(deleteIfSame(m, "p:x", a)).toBe(false);
    expect(m.get("p:x")).toBe(b);
  });

  it("is a no-op for an id that is gone", () => {
    expect(deleteIfSame(new Map(), "p:x", {})).toBe(false);
  });
});
