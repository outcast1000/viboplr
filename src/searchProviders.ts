import type { AppStore } from "./store";

export interface SearchProviderConfig {
  id: string;
  name: string;
  enabled: boolean;
  builtinIcon?: string;
  artistUrl?: string;
  albumUrl?: string;
  trackUrl?: string;
}

export const DEFAULT_PROVIDERS: SearchProviderConfig[] = [
  {
    id: "builtin-google",
    name: "Google",
    enabled: true,
    builtinIcon: "google",
    artistUrl: "https://www.google.com/search?q={artist}",
    albumUrl: "https://www.google.com/search?q={title}+{artist}",
    trackUrl: "https://www.google.com/search?q={title}+{artist}",
  },
  {
    id: "builtin-lastfm",
    name: "Last.fm",
    enabled: true,
    builtinIcon: "lastfm",
    artistUrl: "https://www.last.fm/music/{artist}",
    albumUrl: "https://www.last.fm/music/{artist}/{title}",
    trackUrl: "https://www.last.fm/music/{artist}/_/{title}",
  },
  {
    id: "builtin-x",
    name: "X",
    enabled: true,
    builtinIcon: "x",
    artistUrl: "https://x.com/search?q={artist}",
    albumUrl: "https://x.com/search?q={title}+{artist}",
    trackUrl: "https://x.com/search?q={title}+{artist}",
  },
  {
    id: "builtin-youtube",
    name: "YouTube",
    enabled: true,
    builtinIcon: "youtube",
    artistUrl: "https://www.youtube.com/results?search_query={artist}",
    albumUrl: "https://www.youtube.com/results?search_query={title}+{artist}",
    trackUrl: "https://www.youtube.com/results?search_query={title}+{artist}",
  },
  {
    id: "builtin-genius",
    name: "Genius",
    enabled: true,
    builtinIcon: "genius",
    trackUrl: "https://genius.com/search?q={title}+{artist}",
  },
];

export async function loadProviders(store: AppStore): Promise<SearchProviderConfig[]> {
  const saved = await store.get<SearchProviderConfig[] | null>("searchProviders");
  return saved ?? DEFAULT_PROVIDERS;
}

export async function saveProviders(store: AppStore, providers: SearchProviderConfig[]): Promise<void> {
  await store.set("searchProviders", providers);
}

export function buildSearchUrl(template: string, params: { artist?: string; title?: string }): string {
  let url = template;
  if (params.artist) {
    url = url.replace(/\{artist\}/g, encodeURIComponent(params.artist));
  } else {
    url = url.replace(/[+]?\{artist\}/g, "");
  }
  if (params.title) {
    url = url.replace(/\{title\}/g, encodeURIComponent(params.title));
  } else {
    url = url.replace(/[+]?\{title\}/g, "");
  }
  return url;
}

export function getProvidersForContext(
  providers: SearchProviderConfig[],
  context: "artist" | "album" | "track",
): SearchProviderConfig[] {
  const urlKey = context === "artist" ? "artistUrl" : context === "album" ? "albumUrl" : "trackUrl";
  return providers.filter((p) => p.enabled && p[urlKey]);
}

export function getDomainFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
