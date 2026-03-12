import { type ReactNode } from "react";
import { IconGoogle, IconLastfm, IconX, IconYoutube, IconGenius } from "./components/Icons";

const enc = (s: string) => encodeURIComponent(s);

interface SearchProvider<T> {
  label: string;
  icon: ReactNode;
  buildUrl: (item: T) => string;
}

export const artistSearchProviders: SearchProvider<{ name: string }>[] = [
  { label: "Search on Google", icon: IconGoogle({}), buildUrl: (a) => `https://www.google.com/search?q=${enc(a.name)}` },
  { label: "Search on Last.fm", icon: IconLastfm({}), buildUrl: (a) => `https://www.last.fm/music/${enc(a.name)}` },
  { label: "Search on X", icon: IconX({}), buildUrl: (a) => `https://x.com/search?q=${enc(a.name)}` },
  { label: "Search on YouTube", icon: IconYoutube({}), buildUrl: (a) => `https://www.youtube.com/results?search_query=${enc(a.name)}` },
];

export const albumSearchProviders: SearchProvider<{ title: string; artistName?: string }>[] = [
  { label: "Search on Google", icon: IconGoogle({}), buildUrl: (a) => `https://www.google.com/search?q=${enc(a.title)}${a.artistName ? `+${enc(a.artistName)}` : ""}` },
  { label: "Search on Last.fm", icon: IconLastfm({}), buildUrl: (a) => a.artistName ? `https://www.last.fm/music/${enc(a.artistName)}/${enc(a.title)}` : `https://www.last.fm/search?q=${enc(a.title)}` },
  { label: "Search on X", icon: IconX({}), buildUrl: (a) => `https://x.com/search?q=${enc(a.title)}${a.artistName ? `+${enc(a.artistName)}` : ""}` },
  { label: "Search on YouTube", icon: IconYoutube({}), buildUrl: (a) => `https://www.youtube.com/results?search_query=${enc(a.title)}${a.artistName ? `+${enc(a.artistName)}` : ""}` },
];

export const trackSearchProviders: SearchProvider<{ title: string; artistName?: string }>[] = [
  { label: "Search on Google", icon: IconGoogle({}), buildUrl: (t) => `https://www.google.com/search?q=${enc(t.title)}${t.artistName ? `+${enc(t.artistName)}` : ""}` },
  { label: "Search on Last.fm", icon: IconLastfm({}), buildUrl: (t) => t.artistName ? `https://www.last.fm/music/${enc(t.artistName)}/_/${enc(t.title)}` : `https://www.last.fm/search?q=${enc(t.title)}` },
  { label: "Search on X", icon: IconX({}), buildUrl: (t) => `https://x.com/search?q=${enc(t.title)}${t.artistName ? `+${enc(t.artistName)}` : ""}` },
  { label: "Search on YouTube", icon: IconYoutube({}), buildUrl: (t) => `https://www.youtube.com/results?search_query=${enc(t.title)}${t.artistName ? `+${enc(t.artistName)}` : ""}` },
  { label: "Search Lyrics", icon: IconGenius({}), buildUrl: (t) => `https://genius.com/search?q=${enc(t.title)}${t.artistName ? `+${enc(t.artistName)}` : ""}` },
];
