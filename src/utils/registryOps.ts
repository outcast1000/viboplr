/**
 * Delete `key` from `map` only while it still holds `entry`.
 *
 * Every runtime registration a plugin makes (`registerItem`, `registerShelf`,
 * `registerProvider`, `registerTool`, …) returns an unsubscriber, and those
 * registries are keyed by `pluginId:id`, so re-registering an id replaces the
 * entry. An unsubscriber that deleted by key alone would therefore remove the
 * REPLACEMENT if it ran after it.
 *
 * In the main realm that never happened, because a plugin calls the old
 * unsubscriber synchronously before registering again. In the worker runtime it
 * happens every time: the unsubscriber arrives as a callable promise that runs
 * a microtask later, while the new registration is posted at once — so the
 * host sees "register X, unregister X" and an edit that rebuilds a menu deleted
 * the whole menu (found in search-providers). Deleting by identity makes the
 * order irrelevant. The same holds for a plugin's own handler maps (stream
 * resolvers, download providers, info/image fetchers), which are keyed by id
 * too — every registration goes through `registerKeyed`.
 */
export function deleteIfSame<K, V>(map: Map<K, V>, key: K, entry: V): boolean {
  if (map.get(key) !== entry) return false;
  return map.delete(key);
}

/**
 * Put `value` under `key` and return the unsubscriber that removes it again —
 * only while it is still this registration's (`deleteIfSame`). `onChange` runs
 * after the set and after an unsubscribe that removed something, for
 * registries whose consumers re-read on a version bump.
 */
export function registerKeyed<V>(
  map: Map<string, V>,
  key: string,
  value: V,
  onChange?: () => void,
): () => void {
  map.set(key, value);
  onChange?.();
  return () => {
    if (deleteIfSame(map, key, value)) onChange?.();
  };
}

/** Drop every `${pluginId}:…` entry; true when anything was removed. */
export function deletePluginKeys<V>(map: Map<string, V>, pluginId: string): boolean {
  const prefix = `${pluginId}:`;
  let removed = false;
  for (const key of Array.from(map.keys())) {
    if (key.startsWith(prefix)) {
      map.delete(key);
      removed = true;
    }
  }
  return removed;
}
