export interface FallbackProvider {
  id: string;
  name: string;
  source: string; // "built-in" or plugin ID
  resolve: (
    title: string,
    artistName: string | null,
    albumName: string | null,
  ) => Promise<{ url: string; label: string } | null>;
}

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Iterate providers in order. First non-null result wins.
 * Each provider gets a timeout; rejections are swallowed (skip to next).
 */
export async function resolveFallback(
  providers: FallbackProvider[],
  title: string,
  artistName: string | null,
  albumName: string | null,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ url: string; label: string } | null> {
  for (const provider of providers) {
    try {
      const result = await Promise.race([
        provider.resolve(title, artistName, albumName),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      if (result) return result;
    } catch {
      // Provider threw — skip to next
      continue;
    }
  }
  return null;
}
