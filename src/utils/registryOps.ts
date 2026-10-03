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
 * order irrelevant.
 */
export function deleteIfSame<K, V>(map: Map<K, V>, key: K, entry: V): boolean {
  if (map.get(key) !== entry) return false;
  return map.delete(key);
}
