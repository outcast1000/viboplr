import { describe, expect, it } from "vitest";
import { deleteIfSame, deletePluginKeys, registerKeyed } from "../utils/registryOps";

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

describe("registerKeyed", () => {
  it("sets the entry and notifies once per change", () => {
    const m = new Map<string, string>();
    let changes = 0;
    const unsub = registerKeyed(m, "p:x", "a", () => changes++);
    expect(m.get("p:x")).toBe("a");
    expect(changes).toBe(1);
    unsub();
    expect(m.has("p:x")).toBe(false);
    expect(changes).toBe(2);
    unsub();
    expect(changes).toBe(2);
  });

  it("a late unsubscriber leaves the replacement and stays silent", () => {
    const m = new Map<string, string>();
    let changes = 0;
    const unsubA = registerKeyed(m, "p:x", "a", () => changes++);
    registerKeyed(m, "p:x", "b", () => changes++);
    unsubA();
    expect(m.get("p:x")).toBe("b");
    expect(changes).toBe(2);
  });
});

describe("deletePluginKeys", () => {
  it("removes only that plugin's keys", () => {
    const m = new Map([["p:a", 1], ["p:b", 2], ["pq:a", 3], ["q:p", 4]]);
    expect(deletePluginKeys(m, "p")).toBe(true);
    expect([...m.keys()]).toEqual(["pq:a", "q:p"]);
    expect(deletePluginKeys(m, "p")).toBe(false);
  });
});
