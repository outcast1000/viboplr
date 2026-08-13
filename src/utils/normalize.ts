/**
 * The one JS-side normalization for comparing track/artist/album names,
 * mirroring the backend's `strip_diacritics(unicode_lower(...))` (db/mod.rs)
 * and the entity_likes key normalization (db/likes.rs `norm_segment`).
 *
 * Every in-memory metadata comparison must use this instead of bare
 * `toLowerCase()`: authoritative lookups already go through the backend (per
 * conventions "Track Matching by Metadata"), and a JS comparison that
 * normalizes LESS than the backend drifts — "Björk" from a plugin surface
 * failed to locate "Bjork" in the library, and a diacritic-variant same-song
 * queue copy missed the optimistic like patch, even though the backend
 * matched both.
 *
 * NFD + strip marks is the same decomposition the Rust side uses
 * (unicode-normalization's `is_combining_mark`); `\p{M}` is marginally
 * broader (it includes spacing/enclosing marks), which only ever makes JS
 * matching more forgiving, never less than the backend's.
 */
export function normalizeForMatch(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}
