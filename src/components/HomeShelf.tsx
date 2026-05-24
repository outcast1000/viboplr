import { useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ResolvedShelf } from "../hooks/useHome";
import type { HomeShelfItem } from "../types/plugin";
import "./HomeView.css";

// Resolve any image path (http URL, data URI, or local filesystem path with
// optional `#v=...` cache-busting fragment) to a value usable in <img src>.
function resolveImagePath(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.startsWith("http") || path.startsWith("data:")) return path;
  const hashIdx = path.indexOf("#");
  if (hashIdx >= 0) {
    return convertFileSrc(path.slice(0, hashIdx)) + path.slice(hashIdx);
  }
  return convertFileSrc(path);
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
}

export function HomeShelf({ shelf, albumImageFor, artistImageFor, onItemClick, onItemContextMenu }: HomeShelfProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);

  const scroll = (dir: 1 | -1) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: "smooth" });
  };

  return (
    <section className="home-shelf">
      <div className="home-shelf-header">
        <h2 className="home-shelf-title">{shelf.title}</h2>
        <div className="home-shelf-arrows">
          <button className="ds-btn ds-btn--ghost ds-btn--sm" aria-label="Scroll left" onClick={() => scroll(-1)}>‹</button>
          <button className="ds-btn ds-btn--ghost ds-btn--sm" aria-label="Scroll right" onClick={() => scroll(1)}>›</button>
        </div>
      </div>
      <div className="home-shelf-scroller" ref={scrollerRef}>
        {shelf.items.map((item, i) => renderCard(shelf, item, i, { albumImageFor, artistImageFor, onItemClick, onItemContextMenu }))}
      </div>
    </section>
  );
}

interface RenderCtx {
  albumImageFor: (name: string, artistName?: string) => string | null;
  artistImageFor: (name: string) => string | null;
  onItemClick: (shelf: ResolvedShelf, item: HomeShelfItem) => void;
  onItemContextMenu: (shelf: ResolvedShelf, item: HomeShelfItem, e: React.MouseEvent) => void;
}

function renderCard(shelf: ResolvedShelf, item: HomeShelfItem, idx: number, ctx: RenderCtx) {
  const onClick = () => ctx.onItemClick(shelf, item);
  const onCtx = (e: React.MouseEvent) => { e.preventDefault(); ctx.onItemContextMenu(shelf, item, e); };

  if (shelf.displayKind === "album-cards") {
    const it = item as { libraryId?: number; name: string; artistName?: string; coverUrl?: string };
    const src = resolveImagePath(it.coverUrl ?? ctx.albumImageFor(it.name, it.artistName));
    return (
      <div key={`${idx}-${it.name}`} className="ds-card home-shelf-card" onClick={onClick} onContextMenu={onCtx}>
        <div className="ds-card-art">
          {src ? <img src={src} alt={it.name} /> : <div className="home-shelf-card-fallback">{it.name[0]?.toUpperCase() ?? "?"}</div>}
        </div>
        <div className="ds-card-body">
          <div className="ds-card-title">{it.name}</div>
          {it.artistName && <div className="ds-card-subtitle">{it.artistName}</div>}
        </div>
      </div>
    );
  }
  if (shelf.displayKind === "artist-cards") {
    const it = item as { libraryId?: number; name: string; imageUrl?: string };
    const src = resolveImagePath(it.imageUrl ?? ctx.artistImageFor(it.name));
    return (
      <div key={`${idx}-${it.name}`} className="ds-card ds-card--circular home-shelf-card" onClick={onClick} onContextMenu={onCtx}>
        <div className="ds-card-art">
          {src ? <img src={src} alt={it.name} /> : <div className="home-shelf-card-fallback">{it.name[0]?.toUpperCase() ?? "?"}</div>}
        </div>
        <div className="ds-card-body">
          <div className="ds-card-title">{it.name}</div>
        </div>
      </div>
    );
  }
  if (shelf.displayKind === "playlist-cards") {
    const it = item as { id: string; name: string; coverUrl?: string; trackCount?: number };
    const src = resolveImagePath(it.coverUrl ?? null);
    return (
      <div key={`${idx}-${it.id}`} className="ds-card home-shelf-card" onClick={onClick} onContextMenu={onCtx}>
        <div className="ds-card-art">
          {src ? <img src={src} alt={it.name} /> : <div className="home-shelf-card-fallback">{it.name[0]?.toUpperCase() ?? "?"}</div>}
        </div>
        <div className="ds-card-body">
          <div className="ds-card-title">{it.name}</div>
          {typeof it.trackCount === "number" && <div className="ds-card-subtitle">{it.trackCount} tracks</div>}
        </div>
      </div>
    );
  }
  // track-rows
  const it = item as { track: { title: string; artist_name?: string; album_title?: string; image_url?: string } };
  const explicit = it.track.image_url ?? null;
  const albumPath = !explicit && it.track.album_title
    ? ctx.albumImageFor(it.track.album_title, it.track.artist_name)
    : null;
  const artistPath = !explicit && !albumPath && it.track.artist_name
    ? ctx.artistImageFor(it.track.artist_name)
    : null;
  const src = resolveImagePath(explicit ?? albumPath ?? artistPath);
  return (
    <div key={`${idx}-${it.track.title}`} className="ds-card home-shelf-card home-shelf-card--track" onClick={onClick} onContextMenu={onCtx}>
      <div className="ds-card-art">
        {src ? <img src={src} alt={it.track.title} /> : <div className="home-shelf-card-fallback">{it.track.title[0]?.toUpperCase() ?? "?"}</div>}
      </div>
      <div className="ds-card-body">
        <div className="ds-card-title">{it.track.title}</div>
        {it.track.artist_name && <div className="ds-card-subtitle">{it.track.artist_name}</div>}
      </div>
    </div>
  );
}
