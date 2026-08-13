import { useMemo, useRef } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

/**
 * Gives every function in `handlers` a render-stable identity that always
 * calls the latest closure — the same latest-ref pattern QueuePanel uses for
 * its row handlers, generalized. This is what lets a `memo`ized component
 * (NowPlayingBar) receive inline handlers from App.tsx without every render
 * recreating them and defeating the memo: the wrapper identities never change,
 * while the bodies they dispatch to are refreshed each render.
 *
 * Rules:
 * - The key set is fixed by the first render — handlers are wrapped once.
 * - Wrappers dispatch to the latest closure at CALL time, so they are for
 *   event handlers and render-time getters, not for values captured in
 *   effect dependencies (a stable wrapper never re-fires an effect).
 * - Conditionally-present handlers (`cond ? fn : undefined`) must keep the
 *   condition at the call site — always define the handler here, and pass
 *   `cond ? stable.onX : undefined` so presence still drives child behavior.
 */
export function useStableCallbacks<T extends Record<string, AnyFn>>(handlers: T): T {
  const ref = useRef(handlers);
  ref.current = handlers;
  return useMemo(() => {
    const out: Record<string, AnyFn> = {};
    for (const key of Object.keys(ref.current)) {
      out[key] = (...args: unknown[]) => ref.current[key](...args);
    }
    return out as T;
    // Wrapped once; ref.current keeps the bodies fresh.
  }, []);
}
