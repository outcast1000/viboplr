/** A leading `scheme://` (RFC 3986 scheme). A `://` later in the URL is not one. */
const LEADING_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The host of a URL the user typed, for naming what it points at. Follows the
 * backend's `user_url::assume_scheme`: with no leading scheme one is assumed
 * (which one doesn't change the host), so `example.com/manifest.json` names
 * "example.com". Falls back to the raw string when it still doesn't parse.
 */
export function userUrlHost(url: string): string {
  const trimmed = url.trim();
  try {
    return new URL(LEADING_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`).host || trimmed;
  } catch {
    // Unparseable URL — the raw string is the best name there is.
    return trimmed;
  }
}
