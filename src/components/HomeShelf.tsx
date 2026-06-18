import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { ResolvedShelf } from "../hooks/useHome";
import { shelfDescriptionFor } from "../hooks/useHome";
import type { HomeShelfItem } from "../types/plugin";
import type { Track } from "../types";
import { isVideoTrack } from "../utils";
import { useVideoFrameQueue } from "../hooks/useVideoFrameQueueContext";
import { resolveShelfPlayAction } from "../utils/homeShelfPlay";
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
  onItemPlay: (shelf: ResolvedShelf, item: HomeShelfItem) => void;
}

export function HomeShelf({ shelf, albumImageFor, artistImageFor, onItemClick, onItemContextMenu, onItemPlay }: HomeShelfProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const frameQueue = useVideoFrameQueue();
  // metadata key (artist::title) -> resolved library track id
  const [trackIds, setTrackIds] = useState<Record<string, number>>({});
  const resolvingRef = useRef<Set<string>>(new Set());

  // Resolve metadata -> library track id, then enqueue extraction for video tracks.
  useEffect(() => {
    if (shelf.displayKind !== "track-rows") return;
    for (const item of shelf.items) {
      const track = (item as { track: { title: string; artist_name?: string; album_title?: string; image_url?: string } }).track;
      if (track.image_url) continue;
      const key = `${track.artist_name ?? ""}::${track.title}`;
      if (key in trackIds || resolvingRef.current.has(key)) continue;
      resolvingRef.current.add(key);
      (async () => {
        try {
          const lib = await invoke<Track | null>("find_track_by_metadata", {
            title: track.title,
            artistName: track.artist_name ?? null,
            albumName: track.album_title ?? null,
          });
          if (!lib || lib.id == null || !isVideoTrack(lib)) return;
          const id = lib.id;
          setTrackIds(prev => ({ ...prev, [key]: id }));
          frameQueue.enqueue(id);
        } catch (e) {
          console.error("Failed to resolve home shelf track id:", e);
        } finally {
          resolvingRef.current.delete(key);
        }
      })();
    }
  }, [shelf, trackIds, frameQueue]);

  // Read the queue's stable ready-frame snapshot, then project it to our
  // metadata keys. Both layers must be referentially stable: useSyncExternalStore
  // gets the queue's cached snapshot (stable per-change), and useMemo recomputes
  // the projection only when the snapshot or trackIds change.
  const readyFrames = useSyncExternalStore(
    (cb) => frameQueue.subscribe(cb),
    () => frameQueue.getReadyFrameSnapshot(),
  );
  const videoFrames = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [key, id] of Object.entries(trackIds)) {
      const url = readyFrames[id];
      if (url) out[key] = url;
    }
    return out;
  }, [readyFrames, trackIds]);

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
    const it = item as { libraryId?: number; name: string; artistName?: string; coverUrl?: string };
    const src = resolveImagePath(it.coverUrl ?? ctx.albumImageFor(it.name, it.artistName));
    return (
      <div key={`${idx}-${it.name}`} className="ds-card home-shelf-card" onClick={onClick} onContextMenu={onCtx}>
        <div className="ds-card-art">
          {src ? <img src={src} alt={it.name} /> : <div className="home-shelf-card-fallback">{it.name[0]?.toUpperCase() ?? "?"}</div>}
          {playButton(shelf, item, ctx)}
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
          {playButton(shelf, item, ctx)}
        </div>
        <div className="ds-card-body">
          <div className="ds-card-title">{it.name}</div>
        </div>
      </div>
    );
  }
  if (shelf.displayKind === "playlist-cards") {
    const it = item as { id: string; name: string; coverUrl?: string; subtitle?: string };
    const src = resolveImagePath(it.coverUrl ?? null);
    return (
      <div key={`${idx}-${it.id}`} className="ds-card home-shelf-card" onClick={onClick} onContextMenu={onCtx}>
        <div className="ds-card-art">
          {src ? <img src={src} alt={it.name} /> : <div className="home-shelf-card-fallback">{it.name[0]?.toUpperCase() ?? "?"}</div>}
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
  const it = item as { track: { title: string; artist_name?: string; album_title?: string; image_url?: string } };
  const explicit = it.track.image_url ?? null;
  const videoKey = `${it.track.artist_name ?? ""}::${it.track.title}`;
  // videoFrame is already a converted file URL from VideoFrameQueue — do NOT pass through resolveImagePath.
  const videoFrame = !explicit ? ctx.videoFrames[videoKey] ?? null : null;
  const albumPath = !explicit && !videoFrame && it.track.album_title
    ? ctx.albumImageFor(it.track.album_title, it.track.artist_name)
    : null;
  const artistPath = !explicit && !videoFrame && !albumPath && it.track.artist_name
    ? ctx.artistImageFor(it.track.artist_name)
    : null;
  const src = videoFrame ?? resolveImagePath(explicit ?? albumPath ?? artistPath);
  return (
    <div key={`${idx}-${it.track.title}`} className="ds-card home-shelf-card home-shelf-card--track" onClick={onClick} onContextMenu={onCtx}>
      <div className="ds-card-art">
        {src ? <img src={src} alt={it.track.title} /> : <div className="home-shelf-card-fallback">{it.track.title[0]?.toUpperCase() ?? "?"}</div>}
        {playButton(shelf, item, ctx)}
      </div>
      <div className="ds-card-body">
        <div className="ds-card-title">{it.track.title}</div>
        {it.track.artist_name && <div className="ds-card-subtitle">{it.track.artist_name}</div>}
      </div>
    </div>
  );
}
