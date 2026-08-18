import { useMemo, useState } from "react";
import { useLatestRef } from "./useLatestRef";

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
  const ref = useLatestRef(handlers);
  // The key set is fixed by the first render (see the rules above). It is
  // captured in a lazy useState initializer rather than read off `ref.current`
  // inside the useMemo, because a useMemo body runs *during* render and reading
  // a ref there is the thing `react-hooks/refs` forbids. The ref is now only
  // ever read at call time, inside the wrappers, which is the whole point of it.
  const [keys] = useState(() => Object.keys(handlers));
  return useMemo(() => {
    const out: Record<string, AnyFn> = {};
    for (const key of keys) {
      out[key] = (...args: unknown[]) => ref.current[key](...args);
    }
    return out as T;
    // Wrapped once; ref.current keeps the bodies fresh.
  }, [keys, ref]);
}
