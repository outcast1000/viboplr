import { useCallback, useEffect, useRef, useState } from "react";
import { store } from "../store";
import { mergeWebSearchOrder, type WebSearchOrderEntry } from "../utils/webSearch";

/**
 * A provider list's order + switches as Settings → Providers edits them,
 * persisted under `storeKey` as `[{ id: "pluginId:providerId", enabled }]`
 * (the shape `webSearchOrder` and `streamResolverOrder` use).
 *
 * `loaded` stays false until the stored order has been read: until then
 * nobody knows which providers the user switched off, so a caller must treat
 * every provider as off (fail closed). Writes go straight to the store on the
 * change itself — no effect, so no restore guard to get wrong.
 */
export function useStoredProviderOrder(storeKey: string, label: string) {
  const [order, setOrderState] = useState<WebSearchOrderEntry[] | null>(null);
  const orderRef = useRef<WebSearchOrderEntry[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const saved = await store.get<WebSearchOrderEntry[]>(storeKey);
        if (Array.isArray(saved)) {
          orderRef.current = saved;
          setOrderState(saved);
        }
      } catch (e) {
        // An unreadable store leaves the defaults (every provider on): the
        // alternative is the feature off for the session with no way back.
        console.error(`Failed to read the ${label} provider order:`, e);
      } finally {
        loadedRef.current = true;
        setLoaded(true);
      }
    })();
  }, [storeKey, label]);

  /** Save the rows the user sees; providers not on screen keep their place. */
  const setOrder = useCallback(async (shown: Array<{ key: string; enabled: boolean }>) => {
    if (!loadedRef.current) {
      console.error(`Ignored a ${label} provider order change made before the saved order was read`);
      return;
    }
    const next = mergeWebSearchOrder(shown, orderRef.current);
    orderRef.current = next;
    setOrderState(next);
    try {
      await store.set(storeKey, next);
    } catch (e) {
      console.error(`Failed to persist the ${label} provider order:`, e);
    }
  }, [storeKey, label]);

  /** Back to every provider on, in registration order. */
  const resetOrder = useCallback(async () => {
    orderRef.current = [];
    setOrderState([]);
    try {
      await store.set(storeKey, []);
    } catch (e) {
      console.error(`Failed to reset the ${label} provider order:`, e);
    }
  }, [storeKey, label]);

  return { order, loaded, setOrder, resetOrder };
}
