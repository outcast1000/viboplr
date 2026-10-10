// "Open this detail page on that tab" — `api.ui.navigateToEntity(…, { tab })`.
//
// The navigation itself goes through the ordinary `navigateTo*ByName` paths,
// which know nothing of tabs. So the request is parked here, naming the entity,
// and the page's `InformationSections` takes it when it shows that entity. One-
// shot (taken once) and short-lived, so a request that never found its page
// (the navigation failed) can't hijack a later visit.
//
// Matching folds case and accents (`normalizeForMatch`), because the names come
// from the plugin — a server's "Bjork" opens the library's "Björk" — and an
// album asked for without its artist matches that title under any artist.
// A page already showing the entity hears about the request at once
// (`onDetailTabRequest`): navigating to it changes nothing the page would
// otherwise react to.

import { normalizeForMatch } from "./normalize";

const TTL_MS = 10_000;

export interface DetailTabTarget {
  kind: string;
  name: string;
  artistName?: string | null;
}

let pending: { target: DetailTabTarget; tab: string; at: number } | null = null;
const listeners = new Set<() => void>();

export function requestDetailTab(target: DetailTabTarget, tab: string, now = Date.now()): void {
  pending = { target, tab, at: now };
  for (const l of Array.from(listeners)) l();
}

function sameEntity(want: DetailTabTarget, page: DetailTabTarget): boolean {
  if (want.kind !== page.kind) return false;
  if (normalizeForMatch(want.name.trim()) !== normalizeForMatch(page.name.trim())) return false;
  const wantArtist = want.artistName?.trim();
  if (!wantArtist) return true;
  return normalizeForMatch(wantArtist) === normalizeForMatch((page.artistName ?? "").trim());
}

/** One string per entity, folded the way requests match: two spellings of a
 *  page ("Björk" / "bjork") are the same page. */
export function entityIdentity(page: DetailTabTarget): string {
  const fold = (s: string | null | undefined) => normalizeForMatch((s ?? "").trim());
  return `${page.kind}|${fold(page.artistName)}|${fold(page.name)}`;
}

/** The tab requested for this entity, once; null when none (or it expired). */
export function takeDetailTab(page: DetailTabTarget, now = Date.now()): string | null {
  if (!pending || !sameEntity(pending.target, page)) return null;
  const { tab, at } = pending;
  pending = null;
  return now - at <= TTL_MS ? tab : null;
}

/** Called on every request; returns the unsubscriber. */
export function onDetailTabRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
