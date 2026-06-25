import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { resolveImageSrc } from "../utils/resolveImageUrl";
import { isVideoTrack, getInitials } from "../utils";
import type { QueueTrack } from "../types";
import type { LyricsData } from "../types/informationTypes";
import type { UseLyricsResult } from "../hooks/useLyrics";
import { parseLrc, currentSyncedLineIndex } from "../utils/lyrics";
import "./NowPlayingView.css";

interface NowPlayingViewProps {
  style?: CSSProperties;
  track: QueueTrack | null;
  positionSecs: number;
  lyrics: UseLyricsResult;
  /** Image-provider chain lookups (album → artist fallback). Called during render
      so the async cache-resolve re-render is picked up, same as HomeShelf/cards. */
  getAlbumImage: (name: string, artistName?: string | null) => string | null;
  getArtistImage: (name: string) => string | null;
  /** Seek playback to an absolute position (seconds) — wired to tap-to-seek on synced lines. */
  onSeek?: (secs: number) => void;
}

/** Centered, lean-back lyrics display. Synced (karaoke) when LRC timing is
    available, otherwise centered plain text. Synced auto-scrolls to the active
    line (pausing briefly after manual scroll) and lines are tap-to-seek; plain
    text doesn't auto-scroll (no timing to follow). */
function NowPlayingLyrics({
  data,
  positionSecs,
  onSeek,
}: {
  data: LyricsData;
  positionSecs: number;
  onSeek?: (secs: number) => void;
}) {
  const synced = useMemo(
    () => (data.kind === "synced" && data.text ? parseLrc(data.text) : null),
    [data.kind, data.text],
  );
  const activeIdx = synced ? currentSyncedLineIndex(synced, positionSecs) : -1;

  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const [userScrolled, setUserScrolled] = useState(false);
  const userScrollTimer = useRef<number>(0);
  // Suppress the `scroll` events our own auto-scroll produces so they aren't
  // mistaken for manual scrolling. The window must outlast a smooth
  // scrollIntoView animation (~hundreds of ms).
  const suppressUntil = useRef(0);

  const markProgrammatic = () => { suppressUntil.current = performance.now() + 700; };

  // Synced: keep the active line centered (pauses while the user is scrolling).
  useEffect(() => {
    if (synced && !userScrolled && activeRef.current) {
      markProgrammatic();
      activeRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [synced, activeIdx, userScrolled]);

  // Plain (no timing): no auto-scroll. Without per-line sync there's nothing to
  // follow, so the text stays put and the user scrolls it themselves.

  const onScroll = () => {
    if (performance.now() < suppressUntil.current) return; // ignore our own scrolls
    setUserScrolled(true);
    if (userScrollTimer.current) clearTimeout(userScrollTimer.current);
    userScrollTimer.current = window.setTimeout(() => setUserScrolled(false), 4000);
  };

  useEffect(() => () => { if (userScrollTimer.current) clearTimeout(userScrollTimer.current); }, []);

  if (synced) {
    return (
      <div className="np-lyrics-scroll np-lyrics-scroll--synced" ref={scrollRef} onScroll={onScroll}>
        {synced.map((line, i) => {
          const active = i === activeIdx;
          const state = active ? "active" : i < activeIdx ? "past" : "upcoming";
          return (
            <div
              key={i}
              ref={active ? activeRef : undefined}
              className={`np-lyric-line np-lyric-line--${state}${onSeek ? " np-lyric-line--seekable" : ""}`}
              onClick={onSeek ? () => onSeek(line.time) : undefined}
              title={onSeek ? "Jump to this line" : undefined}
            >
              {line.text || "♪"}
            </div>
          );
        })}
      </div>
    );
  }

  // Plain (no timing): centered static text.
  return (
    <div className="np-lyrics-scroll np-lyrics-scroll--plain" ref={scrollRef} onScroll={onScroll}>
      {data.text.split("\n").map((line, i) => (
        <div key={i} className="np-lyric-line np-lyric-line--plain">{line || " "}</div>
      ))}
    </div>
  );
}

/** Single-source crossfade: when `src` changes the incoming layer fades in on
    top of the previous one, which is pruned once the fade completes. Used for
    the album art and the blurred backdrop so a track change dissolves instead of
    snapping. Layers beneath the top stay fully opaque, so there's no mid-fade dip
    to the background. */
function Crossfade({
  src,
  className,
  render,
}: {
  src: string | null;
  className?: string;
  render: (src: string) => ReactNode;
}) {
  const [layers, setLayers] = useState<{ id: number; src: string }[]>([]);
  const nextId = useRef(0);
  const pruneTimer = useRef(0);

  useEffect(() => {
    if (!src) {
      setLayers([]);
      return;
    }
    setLayers((prev) => {
      if (prev.length && prev[prev.length - 1].src === src) return prev; // unchanged
      // Keep only the just-departing layer beneath the incoming one.
      return [...prev.slice(-1), { id: nextId.current++, src }];
    });
  }, [src]);

  // Fallback prune to a single layer after the fade window, so layers can't
  // accumulate even when `transitionend` never fires (e.g. reduced motion).
  useEffect(() => {
    if (layers.length <= 1) return;
    if (pruneTimer.current) clearTimeout(pruneTimer.current);
    pruneTimer.current = window.setTimeout(
      () => setLayers((prev) => prev.slice(-1)),
      700,
    );
    return () => {
      if (pruneTimer.current) clearTimeout(pruneTimer.current);
    };
  }, [layers]);

  return (
    <div className={`np-xfade ${className ?? ""}`} aria-hidden="true">
      {layers.map((layer, i) => (
        <CrossfadeLayer key={layer.id} top={i === layers.length - 1}>
          {render(layer.src)}
        </CrossfadeLayer>
      ))}
    </div>
  );
}

function CrossfadeLayer({ top, children }: { top: boolean; children: ReactNode }) {
  // Mount hidden and reveal on the next frame so the opacity transition actually
  // runs (same deferred-reveal trick as DetailHeroBackground). Only the topmost
  // layer fades in; layers beneath stay opaque until pruned.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const hidden = top && !entered;
  return (
    <div className={`np-xfade-layer${hidden ? " np-xfade-layer--enter" : ""}`}>
      {children}
    </div>
  );
}

export function NowPlayingView({
  style,
  track,
  positionSecs,
  lyrics,
  getAlbumImage,
  getArtistImage,
  onSeek,
}: NowPlayingViewProps) {
  const isVideo = track ? isVideoTrack(track) : false;

  // Read-only tags for the metadata line. NowPlayingView operates on a
  // QueueTrack (no DB id), so resolve to a library track by metadata; tags show
  // only for tracks that exist in the library. Editing lives in the Now Playing
  // bar's tag popover and the track detail page, not in this lean-back view.
  const [trackTags, setTrackTags] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!track) { setTrackTags([]); return; }
    invoke<{ id: number } | null>("find_track_by_metadata", {
      title: track.title,
      artistName: track.artist_name ?? null,
      albumName: track.album_title ?? null,
    })
      .then((lib) => {
        if (cancelled) return;
        if (!lib) { setTrackTags([]); return; }
        invoke<Array<{ id: number; name: string }>>("get_tags_for_track", { trackId: lib.id })
          .then((rows) => { if (!cancelled) setTrackTags(rows.map((r) => r.name)); })
          .catch((e) => console.error("Failed to load tags for now-playing track:", e));
      })
      .catch((e) => console.error("Failed to resolve now-playing track:", e));
    return () => { cancelled = true; };
  }, [track?.title, track?.artist_name, track?.album_title]);

  // Resolve art via the image-provider plugin chain: explicit url → album → artist.
  let albumImageSrc: string | null = null;
  if (track && !isVideo) {
    if (track.image_url) {
      albumImageSrc = resolveImageSrc(track.image_url);
    } else {
      const albumPath = track.album_title ? getAlbumImage(track.album_title, track.artist_name) : null;
      const artistPath = !albumPath && track.artist_name ? getArtistImage(track.artist_name) : null;
      albumImageSrc = resolveImageSrc(albumPath ?? artistPath);
    }
  }

  // Keyed on the track identity so a track change remounts the line and replays
  // the entrance animation (it stays put across position ticks).
  const metaLine = useMemo(() => {
    if (!track) return null;
    const parts = [track.artist_name, track.album_title].filter(Boolean) as string[];
    return (
      <div className="np-meta np-enter" key={track.key}>
        <div className="np-title">{track.title}</div>
        {parts.length > 0 && <div className="np-subtitle">{parts.join(" · ")}</div>}
      </div>
    );
  }, [track]);

  if (!track) {
    return (
      <div className="now-playing-view np-empty" style={style}>
        <div className="np-empty-msg">Nothing playing</div>
      </div>
    );
  }

  // Video: the shared <video> element is layered over this area by App.tsx
  // (.video-container--theater). We only reserve space + show metadata.
  if (isVideo) {
    return (
      <div className="now-playing-view np-video" style={style}>
        <div className="np-video-spacer" />
      </div>
    );
  }

  // Audio: blurred-art backdrop + sharp art + centered karaoke/plain lyrics,
  // with an up-next peek on the side.
  const hasArt = !!albumImageSrc;
  const hasLyrics = lyrics.status === "loaded" && !!lyrics.data;
  return (
    <div
      className={`now-playing-view np-audio${hasArt ? "" : " np-audio--noart"}${hasLyrics ? "" : " np-audio--nolyrics"}`}
      style={style}
    >
      {hasArt && (
        <Crossfade
          src={albumImageSrc}
          className="np-xfade--backdrop"
          render={(src) => (
            <div className="np-backdrop" style={{ backgroundImage: `url("${src}")` }} />
          )}
        />
      )}
      <div className="np-stage">
        <div className="np-art-col">
          {hasArt ? (
            <Crossfade
              src={albumImageSrc}
              className="np-xfade--art"
              render={(src) => <img className="np-art" src={src} alt="" />}
            />
          ) : (
            <div key={track.key} className="np-art np-art--placeholder np-enter">
              {getInitials(track.title)}
            </div>
          )}
        </div>
        <div className="np-lyrics-col">
          {lyrics.status === "loaded" && lyrics.data ? (
            <NowPlayingLyrics key={track.key} data={lyrics.data} positionSecs={positionSecs} onSeek={onSeek} />
          ) : lyrics.status === "loading" ? (
            <div className="np-lyrics-hint" aria-hidden="true" />
          ) : null}
        </div>
      </div>
      {metaLine}
      {trackTags.length > 0 && (
        <div className="np-tags np-enter" key={`${track.key}-tags`}>{trackTags.join(" · ")}</div>
      )}
    </div>
  );
}
