// User-facing knobs for how a radio station is filled once the seed plays
// (Settings → Playback → Radio). Mirrors `RadioOptions` / `RadioTaste` in
// `src-tauri/src/models.rs`; the backend applies them in
// `Database::build_radio_for_track`. Persisted as one store key,
// `radioOptions`, so a partial or malformed value from an older build reads
// as the defaults field by field rather than failing the whole object.

export type RadioTaste = "favorites" | "mixed" | "discovery";

export interface RadioOptions {
  /** Percent of non-seed slots offered to the seed's own artist first (0–100).
   *  0 keeps that artist out of the station entirely; the seed still opens it. */
  artistShare: number;
  taste: RadioTaste;
  /** Cap every artist other than the seed's at a few tracks per station. */
  spreadArtists: boolean;
}

/** Today's behaviour: half the slots go to the seed's artist, uniform draw, no cap. */
export const DEFAULT_RADIO_OPTIONS: RadioOptions = {
  artistShare: 50,
  taste: "mixed",
  spreadArtists: false,
};

/** The share values the Settings select offers, with their labels. */
export const RADIO_ARTIST_SHARE_CHOICES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 50, label: "Mostly the seed artist" },
  { value: 25, label: "Balanced" },
  { value: 10, label: "Just a taste" },
  { value: 0, label: "Other artists only" },
];

export const RADIO_TASTE_CHOICES: ReadonlyArray<{ value: RadioTaste; label: string }> = [
  { value: "favorites", label: "Favorites" },
  { value: "mixed", label: "Mixed" },
  { value: "discovery", label: "Discovery" },
];

const TASTES: ReadonlySet<string> = new Set<RadioTaste>(["favorites", "mixed", "discovery"]);

/** Read a persisted value defensively: each field falls back to its default. */
export function coerceRadioOptions(raw: unknown): RadioOptions {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const share = typeof src.artistShare === "number" && Number.isFinite(src.artistShare)
    ? Math.min(100, Math.max(0, Math.round(src.artistShare)))
    : DEFAULT_RADIO_OPTIONS.artistShare;
  const taste = typeof src.taste === "string" && TASTES.has(src.taste)
    ? (src.taste as RadioTaste)
    : DEFAULT_RADIO_OPTIONS.taste;
  const spreadArtists = typeof src.spreadArtists === "boolean"
    ? src.spreadArtists
    : DEFAULT_RADIO_OPTIONS.spreadArtists;
  return { artistShare: share, taste, spreadArtists };
}
