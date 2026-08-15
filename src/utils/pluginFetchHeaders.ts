/**
 * Shapes the header half of `api.network.fetch`'s response.
 *
 * The backend (`plugin_fetch`) sends headers as ordered `[name, value]` pairs
 * with lowercased names, because `Set-Cookie` may repeat and a map would keep
 * only the last one. Plugins want both views of that: a plain lookup map for
 * the ordinary single-valued headers, and the full list for cookies.
 */
export type PluginHeaderPairs = Array<[string, string]>;

/**
 * Fold ordered pairs into a lookup map, joining repeats with ", " the way the
 * Fetch spec's `Headers.get()` does. That join is lossy for `Set-Cookie` (a
 * cookie value can itself contain a comma, so the result can't be split back
 * apart safely) — which is exactly why `getSetCookie()` exists alongside it.
 */
export function foldHeaderPairs(pairs: PluginHeaderPairs): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of pairs) {
    const key = name.toLowerCase();
    out[key] = key in out ? `${out[key]}, ${value}` : value;
  }
  return out;
}

/** Every `Set-Cookie` value, in the order the server sent them. */
export function setCookieValues(pairs: PluginHeaderPairs): string[] {
  return pairs.filter(([name]) => name.toLowerCase() === "set-cookie").map(([, value]) => value);
}
