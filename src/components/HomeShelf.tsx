import { useRef, useState } from "react";
import type { ResolvedShelf } from "../hooks/useHome";
import { shelfDescriptionFor } from "../hooks/useHome";
import type { HomeShelfItem, PluginTrack } from "../types/plugin";
import { useShelfVideoFrames, shelfVideoKey } from "../hooks/useShelfVideoFrames";
import { resolveShelfPlayAction } from "../utils/homeShelfPlay";
import { resolveImageUrl } from "../utils/resolveImageUrl";
import { resolveTrackImage } from "../utils/trackImage";
import "./HomeView.css";

// First track's album image, falling back to its artist image — the on-demand
// (fetch + refresh) cover for a playlist card with no explicit coverUrl. Used for
// radio stations (seed track) and plugin playlists that didn't ship a cover.
function playlistFallbackImage(
  tracks: PluginTrack[] | undefined,
  albumImageFor: (name: string, artistName?: string) => string | null,
  artistImageFor: (name: string) => string | null,
): string | null {
  const seed = tracks?.[0];
  if (!seed) return null;
  return (
    (seed.album_title ? albumImageFor(seed.album_title, seed.artist_name ?? undefined) : null) ??
    (seed.artist_name ? artistImageFor(seed.artist_name) : null)
  );
}

// Renders a shelf card's art with graceful degradation. `candidates` is an
// ordered list of already-resolved `<img src>` values (first usable one wins);
// on a load failure that src is dropped and the next is tried. When every
// candidate is missing or fails, the first-letter placeholder renders instead of
// the browser's broken-image glyph. Mirrors QueueItemThumb in QueuePanel.tsx.
function ShelfCardArt({ candidates, name }: { candidates: (string | null | undefined)[]; name: string }) {
  const [failedSrcs, setFailedSrcs] = useState<Set<string>>(new Set());
  const src = candidates.find((s): s is string => !!s && !failedSrcs.has(s)) ?? null;
  if (!src) {
    return <div className="home-shelf-card-fallback">{name[0]?.toUpperCase() ?? "?"}</div>;
  }
  return (
    <img
      key={src}
      src={src}
      alt={name}
      onError={() => setFailedSrcs(prev => new Set(prev).add(src))}
    />
  );
}

export interface HomeShelfProps {
  shelf: ResolvedShelf;
  albumImageFor: (name: string, artistName?: string) => string | null;
  artistImageFor: (name: string) => string | null;
  onItemClick: (shelf: ResolvedShelf, item: HomeShelfItem) => void;
  onItemContextMenu: (
    shelf: ResolvedShelf,
    item: HomeShelfItem,
    e: React.MouseEvent,
  ) => void;
  onItemPlay: (shelf: ResolvedShelf, item: HomeShelfItem) => void;
}

export function HomeShelf({ shelf, albumImageFor, artistImageFor, onItemClick, onItemContextMenu, onItemPlay }: HomeShelfProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const videoFrames = useShelfVideoFrames(shelf);

  const scroll = (dir: 1 | -1) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: "smooth" });
  };

  return (
    <section className="home-shelf">
      <div className="home-shelf-header">
        <div className="home-shelf-heading">
          <h2 className="home-shelf-title">{shelf.title}</h2>
          {shelfDescriptionFor(shelf.id) && (
            <p className="home-shelf-desc">{shelfDescriptionFor(shelf.id)}</p>
          )}
        </div>
        <div className="home-shelf-arrows">
          <button className="ds-btn ds-btn--ghost ds-btn--sm" aria-label="Scroll left" onClick={() => scroll(-1)}>‹</button>
          <button className="ds-btn ds-btn--ghost ds-btn--sm" aria-label="Scroll right" onClick={() => scroll(1)}>›</button>
        </div>
      </div>
      <div className="home-shelf-scroller" ref={scrollerRef}>
        {shelf.items.map((item, i) => renderCard(shelf, item, i, { albumImageFor, artistImageFor, onItemClick, onItemContextMenu, onItemPlay, videoFrames }))}
      </div>
    </section>
  );
}

interface RenderCtx {
  albumImageFor: (name: string, artistName?: string) => string | null;
  artistImageFor: (name: string) => string | null;
  onItemClick: (shelf: ResolvedShelf, item: HomeShelfItem) => void;
  onItemContextMenu: (shelf: ResolvedShelf, item: HomeShelfItem, e: React.MouseEvent) => void;
  onItemPlay: (shelf: ResolvedShelf, item: HomeShelfItem) => void;
  // key (artist::title) -> already-converted file URL (from VideoFrameQueue)
  videoFrames: Record<string, string>;
}

function playButton(shelf: ResolvedShelf, item: HomeShelfItem, ctx: RenderCtx) {
  if (resolveShelfPlayAction(shelf.displayKind, item).kind === "none") return null;
  return (
    <button
      className="ds-card-play"
      title="Play"
      onClick={(e) => { e.stopPropagation(); ctx.onItemPlay(shelf, item); }}
    >
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg>
    </button>
  );
}

function renderCard(shelf: ResolvedShelf, item: HomeShelfItem, idx: number, ctx: RenderCtx) {
  const onClick = () => ctx.onItemClick(shelf, item);
  const onCtx = (e: React.MouseEvent) => { e.preventDefault(); ctx.onItemContextMenu(shelf, item, e); };

  if (shelf.displayKind === "album-cards") {
    const it = item as { libraryId?: number; name: string; artistName?: string; coverUrl?: string; entityKind?: "album" | "artist" };
    // Mixed shelves (e.g. builtin:jump-back-in) tag artist items: render them
    // circular with an artist-image lookup, matching the artist-cards look.
    const isArtist = it.entityKind === "artist";
    // Album cards: explicit cover → album image → the album's artist image →
    // (in ShelfCardArt) first-letter placeholder. The artist fallback is only
    // evaluated when there's no album art, so it adds no fetch when art exists
    // and never runs for mixed-shelf artist items.
    const src = resolveImageUrl(
      it.coverUrl ?? (isArtist
        ? ctx.artistImageFor(it.name)
        : (ctx.albumImageFor(it.name, it.artistName) ?? (it.artistName ? ctx.artistImageFor(it.artistName) : null))),
    );
    return (
      <div key={`${idx}-${it.name}`} className={`ds-card home-shelf-card${isArtist ? " ds-card--circular" : ""}`} onClick={onClick} onContextMenu={onCtx}>
        <div className="ds-card-art">
          <ShelfCardArt candidates={[src]} name={it.name} />
          {playButton(shelf, item, ctx)}
        </div>
        <div className="ds-card-body">
          <div className="ds-card-title">{it.name}</div>
          {!isArtist && it.artistName && <div className="ds-card-subtitle">{it.artistName}</div>}
        </div>
      </div>
    );
  }
  if (shelf.displayKind === "artist-cards") {
    const it = item as { libraryId?: number; name: string; imageUrl?: string };
    const src = resolveImageUrl(it.imageUrl ?? ctx.artistImageFor(it.name));
    return (
      <div key={`${idx}-${it.name}`} className="ds-card ds-card--circular home-shelf-card" onClick={onClick} onContextMenu={onCtx}>
        <div className="ds-card-art">
          <ShelfCardArt candidates={[src]} name={it.name} />
          {playButton(shelf, item, ctx)}
        </div>
        <div className="ds-card-body">
          <div className="ds-card-title">{it.name}</div>
        </div>
      </div>
    );
  }
  if (shelf.displayKind === "playlist-cards") {
    const it = item as { id: string; name: string; coverUrl?: string; subtitle?: string; tracks?: PluginTrack[] };
    const src = resolveImageUrl(it.coverUrl ?? playlistFallbackImage(it.tracks, ctx.albumImageFor, ctx.artistImageFor));
    return (
      <div key={`${idx}-${it.id}`} className="ds-card home-shelf-card" onClick={onClick} onContextMenu={onCtx}>
        <div className="ds-card-art">
          <ShelfCardArt candidates={[src]} name={it.name} />
          {playButton(shelf, item, ctx)}
        </div>
        <div className="ds-card-body">
          <div className="ds-card-title">{it.name}</div>
          {it.subtitle && <div className="ds-card-subtitle">{it.subtitle}</div>}
        </div>
      </div>
    );
  }
  // track-rows
  const it = item as { track: { title: string; artist_name?: string; album_title?: string; path?: string | null; image_url?: string } };
  // Shared chain (image_url → video frame → album → artist), identical to the
  // queue panel. Video frame URLs from the queue are already converted and used
  // verbatim; everything else goes through resolveImageUrl inside the helper.
  const src = resolveTrackImage(it.track, {
    albumImageFor: ctx.albumImageFor,
    artistImageFor: ctx.artistImageFor,
    videoFrame: ctx.videoFrames[shelfVideoKey(it.track.path)] ?? null,
  });
  return (
    <div key={`${idx}-${it.track.title}`} className="ds-card home-shelf-card home-shelf-card--track" onClick={onClick} onContextMenu={onCtx}>
      <div className="ds-card-art">
        <ShelfCardArt candidates={[src]} name={it.track.title} />
        {playButton(shelf, item, ctx)}
      </div>
      <div className="ds-card-body">
        <div className="ds-card-title">{it.track.title}</div>
        {it.track.artist_name && <div className="ds-card-subtitle">{it.track.artist_name}</div>}
      </div>
    </div>
  );
}
