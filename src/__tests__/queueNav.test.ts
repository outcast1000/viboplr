import { describe, it, expect } from "vitest";
import { nextIndex, prevIndex, randomizeOrder } from "../queueNav";

describe("nextIndex", () => {
  it("normal: advances by 1", () => {
    expect(nextIndex("normal", 0, 3)).toBe(1);
    expect(nextIndex("normal", 1, 3)).toBe(2);
  });
  it("normal: returns null at end (no wrap)", () => {
    expect(nextIndex("normal", 2, 3)).toBeNull();
  });
  it("repeat-all: wraps to 0 at end", () => {
    expect(nextIndex("repeat-all", 2, 3)).toBe(0);
    expect(nextIndex("repeat-all", 0, 3)).toBe(1);
  });
  it("repeat-one: returns same index", () => {
    expect(nextIndex("repeat-one", 1, 3)).toBe(1);
    expect(nextIndex("repeat-one", 2, 3)).toBe(2);
  });
  it("empty queue: returns null", () => {
    expect(nextIndex("normal", 0, 0)).toBeNull();
    expect(nextIndex("repeat-all", 0, 0)).toBeNull();
    expect(nextIndex("repeat-one", 0, 0)).toBeNull();
  });
});

describe("prevIndex", () => {
  it("normal: goes back by 1, stops at 0", () => {
    expect(prevIndex("normal", 2, 3)).toBe(1);
    expect(prevIndex("normal", 0, 3)).toBeNull();
  });
  it("repeat-all: wraps to last at 0", () => {
    expect(prevIndex("repeat-all", 0, 3)).toBe(2);
    expect(prevIndex("repeat-all", 1, 3)).toBe(0);
  });
  it("repeat-one: returns same index", () => {
    expect(prevIndex("repeat-one", 1, 3)).toBe(1);
  });
  it("empty queue: returns null", () => {
    expect(prevIndex("normal", 0, 0)).toBeNull();
  });
});

describe("randomizeOrder", () => {
  it("puts the current index's element first", () => {
    const order = randomizeOrder(5, 2, () => 0);
    expect(order[0]).toBe(2);
  });
  it("is a permutation of all indices", () => {
    const order = randomizeOrder(5, 2, Math.random);
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });
  it("single element returns [current]", () => {
    expect(randomizeOrder(1, 0, Math.random)).toEqual([0]);
  });
  it("no current (-1): permutation starting anywhere", () => {
    const order = randomizeOrder(3, -1, () => 0);
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(order.length).toBe(3);
  });
  it("empty returns []", () => {
    expect(randomizeOrder(0, -1, Math.random)).toEqual([]);
  });
});
