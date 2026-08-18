// Pins the contract of the "latest ref" primitives, which 95 converted call
// sites now depend on. The properties that matter are all about *timing*: the
// value must be readable by anything that runs after commit, and — critically —
// it must already be fresh by the time a CHILD's effect runs, since layout and
// passive effects run child-before-parent. That ordering is the whole reason
// these write inside useInsertionEffect rather than useEffect, and it is the one
// thing a future "simplification" to useEffect would silently break.
import { describe, it, expect } from "vitest";
import { render, renderHook, act, cleanup } from "@testing-library/react";
import { useEffect, useLayoutEffect, useRef, useState, StrictMode } from "react";
import { useAssignRef, useLatestRef } from "../hooks/useLatestRef";

describe("useLatestRef", () => {
  it("holds the initial value on the first render", () => {
    const { result } = renderHook(() => useLatestRef(1));
    expect(result.current.current).toBe(1);
  });

  it("tracks the newest value across re-renders", () => {
    const { result, rerender } = renderHook(({ v }) => useLatestRef(v), {
      initialProps: { v: "a" },
    });
    rerender({ v: "b" });
    expect(result.current.current).toBe("b");
    rerender({ v: "c" });
    expect(result.current.current).toBe("c");
    cleanup();
  });

  it("gives a stable ref identity", () => {
    const seen = new Set<object>();
    const { result, rerender } = renderHook(({ v }) => {
      const ref = useLatestRef(v);
      seen.add(ref);
      return ref;
    }, { initialProps: { v: 0 } });
    rerender({ v: 1 });
    rerender({ v: 2 });
    expect(seen.size).toBe(1);
    expect(result.current.current).toBe(2);
    cleanup();
  });
});

describe("useAssignRef", () => {
  it("feeds a ref that was declared earlier (the forward-declaration case)", () => {
    const { result, rerender } = renderHook(({ v }) => {
      // Shape used throughout App.tsx: the ref is created (and handed to a
      // consumer) long before the value it will carry exists.
      const ref = useRef<number>(0);
      useAssignRef(ref, v);
      return ref;
    }, { initialProps: { v: 10 } });
    expect(result.current.current).toBe(10);
    rerender({ v: 20 });
    expect(result.current.current).toBe(20);
    cleanup();
  });

  it("keeps a callback ref pointing at the latest closure", () => {
    const { result, rerender } = renderHook(({ n }) => {
      const ref = useRef<() => number>(() => -1);
      useAssignRef(ref, () => n * 2);
      return ref;
    }, { initialProps: { n: 1 } });
    expect(result.current.current()).toBe(2);
    rerender({ n: 21 });
    expect(result.current.current()).toBe(42);
    cleanup();
  });

  it("survives StrictMode's double render with the correct value", () => {
    const { result, rerender } = renderHook(({ v }) => {
      const ref = useRef(0);
      useAssignRef(ref, v);
      return ref;
    }, { initialProps: { v: 1 }, wrapper: StrictMode });
    expect(result.current.current).toBe(1);
    rerender({ v: 2 });
    expect(result.current.current).toBe(2);
    cleanup();
  });

  /**
   * THE ordering guarantee. A parent feeds a ref and passes it down; the child
   * reads it in its own layout AND passive effect. Child effects run before the
   * parent's, so writing the ref in a parent `useEffect`/`useLayoutEffect` would
   * hand the child the PREVIOUS value. `useInsertionEffect` runs for the whole
   * tree during the mutation phase, ahead of both.
   */
  it("is fresh before a child's layout and passive effects run", () => {
    const layoutSaw: number[] = [];
    const passiveSaw: number[] = [];

    function Child({ valueRef }: { valueRef: React.RefObject<number> }) {
      useLayoutEffect(() => { layoutSaw.push(valueRef.current); });
      useEffect(() => { passiveSaw.push(valueRef.current); });
      return null;
    }

    function Parent() {
      const [v, setV] = useState(1);
      const valueRef = useRef(0);
      useAssignRef(valueRef, v);
      return (
        <>
          <button onClick={() => setV(2)}>go</button>
          <Child valueRef={valueRef} />
        </>
      );
    }

    const { getByText } = render(<Parent />);
    expect(layoutSaw).toEqual([1]);
    expect(passiveSaw).toEqual([1]);

    act(() => { getByText("go").click(); });
    expect(layoutSaw).toEqual([1, 2]);
    expect(passiveSaw).toEqual([1, 2]);
    cleanup();
  });
});
