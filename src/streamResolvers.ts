export interface StreamResolver {
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
 * Iterate resolvers in order. First non-null result wins.
 * Each resolver gets a timeout; rejections are swallowed (skip to next).
 */
export async function resolveStreamChain(
  resolvers: StreamResolver[],
  title: string,
  artistName: string | null,
  albumName: string | null,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ url: string; label: string } | null> {
  for (const resolver of resolvers) {
    try {
      const result = await Promise.race([
        resolver.resolve(title, artistName, albumName),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      if (result) return result;
    } catch {
      // Resolver threw — skip to next
      continue;
    }
  }
  return null;
}
