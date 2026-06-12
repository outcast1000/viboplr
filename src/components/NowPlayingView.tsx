import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { isVideoTrack, getInitials } from "../utils";
import type { QueueTrack } from "../types";
import type { LyricsData } from "../types/informationTypes";
import type { UseLyricsResult } from "../hooks/useLyrics";
import "./NowPlayingView.css";

interface NowPlayingViewProps {
  style?: CSSProperties;
  track: QueueTrack | null;
  positionSecs: number;
  durationSecs: number;
  lyrics: UseLyricsResult;
  /** The full queue + current index, used to show the up-next peek. */
  queue: QueueTrack[];
  queueIndex: number;
  /** Image-provider chain lookups (album → artist fallback). Called during render
      so the async cache-resolve re-render is picked up, same as HomeShelf/cards. */
  getAlbumImage: (name: string, artistName?: string | null) => string | null;
  getArtistImage: (name: string) => string | null;
  /** Seek playback to an absolute position (seconds) — wired to tap-to-seek on synced lines. */
  onSeek?: (secs: number) => void;
  /** Jump playback to a queue index — wired to up-next item clicks. */
  onPlayQueueIndex?: (index: number) => void;
}

/** Resolve a local image path to a webview-usable src (remote URLs pass through). */
function toSrc(path: string | null): string | null {
  if (!path) return null;
  if (/^(https?:|data:)/.test(path)) return path;
  if (path.startsWith("file://")) return convertFileSrc(path.substring(7));
  return convertFileSrc(path);
}

interface LrcLine {
  time: number;
  text: string;
}

function parseLrc(lrc: string): LrcLine[] {
  const lines: LrcLine[] = [];
  for (const line of lrc.split("\n")) {
    const match = line.match(/^\[(\d{2}):(\d{2})(?:[.:](\d{2,3}))?\](.*)$/);
    if (match) {
      const mins = parseInt(match[1], 10);
      const secs = parseInt(match[2], 10);
      const cs = match[3] ? parseInt(match[3], 10) / (match[3].length === 3 ? 1000 : 100) : 0;
      const text = match[4].trim();
      lines.push({ time: mins * 60 + secs + cs, text });
    }
  }
  return lines;
}

function currentLineIndex(lines: LrcLine[], position: number): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= position) idx = i;
    else break;
  }
  return idx;
}

/** Centered, lean-back lyrics display. Synced (karaoke) when LRC timing is
    available, otherwise centered plain text. Auto-scrolls to the active line,
    pausing briefly after manual scroll. Synced lines are tap-to-seek. */
function NowPlayingLyrics({
  data,
  positionSecs,
  durationSecs,
  onSeek,
}: {
  data: LyricsData;
  positionSecs: number;
  durationSecs: number;
  onSeek?: (secs: number) => void;
}) {
  const synced = useMemo(
    () => (data.kind === "synced" && data.text ? parseLrc(data.text) : null),
    [data.kind, data.text],
  );
  const activeIdx = synced ? currentLineIndex(synced, positionSecs) : -1;

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

  // Plain (no timing): no per-line sync, so follow the song by scrolling
  // proportionally to playback progress — only when the text overflows the
  // panel. Deterministic from position, so we always follow (no user-pause):
  // direct scrollTop, not smooth, since position ticks are frequent and small.
  useEffect(() => {
    if (synced) return;
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0 || !(durationSecs > 0)) return; // fits, or unknown duration
    const progress = Math.min(1, Math.max(0, positionSecs / durationSecs));
    markProgrammatic();
    el.scrollTop = progress * max;
  }, [synced, positionSecs, durationSecs]);

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

/** "Up next" peek: the upcoming queue tracks, click to jump. */
function UpNext({
  items,
  getAlbumImage,
  getArtistImage,
  onPlayIndex,
}: {
  items: { t: QueueTrack; i: number }[];
  getAlbumImage: (name: string, artistName?: string | null) => string | null;
  getArtistImage: (name: string) => string | null;
  onPlayIndex?: (index: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="np-upnext">
      <div className="np-upnext-title">Up next</div>
      <div className="np-upnext-list">
        {items.map(({ t, i }) => {
          const albumPath = t.image_url
            ? null
            : t.album_title
            ? getAlbumImage(t.album_title, t.artist_name)
            : null;
          const artistPath = !t.image_url && !albumPath && t.artist_name ? getArtistImage(t.artist_name) : null;
          const src = toSrc(t.image_url ?? albumPath ?? artistPath);
          return (
            <button
              key={t.key}
              className="np-upnext-row"
              onClick={() => onPlayIndex?.(i)}
              title={`Play ${t.title}`}
            >
              {src ? (
                <img className="np-upnext-art" src={src} alt="" />
              ) : (
                <span className="np-upnext-art np-upnext-art--placeholder">{getInitials(t.title)}</span>
              )}
              <span className="np-upnext-info">
                <span className="np-upnext-track-title">{t.title}</span>
                {t.artist_name && <span className="np-upnext-track-artist">{t.artist_name}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function NowPlayingView({
  style,
  track,
  positionSecs,
  durationSecs,
  lyrics,
  queue,
  queueIndex,
  getAlbumImage,
  getArtistImage,
  onSeek,
  onPlayQueueIndex,
}: NowPlayingViewProps) {
  const isVideo = track ? isVideoTrack(track) : false;

  // Up-next: the tracks after the current one (capped). Indices are absolute
  // into `queue` so clicks can jump directly.
  const upNext = useMemo(() => {
    if (queueIndex < 0) return [];
    return queue
      .map((t, i) => ({ t, i }))
      .filter(({ i }) => i > queueIndex)
      .slice(0, 30);
  }, [queue, queueIndex]);

  // Resolve art via the image-provider plugin chain: explicit url → album → artist.
  let albumImageSrc: string | null = null;
  if (track && !isVideo) {
    if (track.image_url) {
      albumImageSrc = toSrc(track.image_url);
    } else {
      const albumPath = track.album_title ? getAlbumImage(track.album_title, track.artist_name) : null;
      const artistPath = !albumPath && track.artist_name ? getArtistImage(track.artist_name) : null;
      albumImageSrc = toSrc(albumPath ?? artistPath);
    }
  }

  const metaLine = useMemo(() => {
    if (!track) return null;
    const parts = [track.artist_name, track.album_title].filter(Boolean) as string[];
    return (
      <div className="np-meta">
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
        {metaLine}
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
        <div
          className="np-backdrop"
          style={{ backgroundImage: `url("${albumImageSrc}")` }}
        />
      )}
      <div className="np-stage">
        <div className="np-art-col">
          {hasArt ? (
            <img className="np-art" src={albumImageSrc!} alt="" />
          ) : (
            <div className="np-art np-art--placeholder">{getInitials(track.title)}</div>
          )}
        </div>
        <div className="np-lyrics-col">
          {lyrics.status === "loaded" && lyrics.data ? (
            <NowPlayingLyrics data={lyrics.data} positionSecs={positionSecs} durationSecs={durationSecs} onSeek={onSeek} />
          ) : lyrics.status === "loading" ? (
            <div className="np-lyrics-hint" aria-hidden="true" />
          ) : null}
        </div>
      </div>
      {metaLine}
      {/* Floats in the bottom-right corner, over the stage. */}
      <UpNext
        items={upNext}
        getAlbumImage={getAlbumImage}
        getArtistImage={getArtistImage}
        onPlayIndex={onPlayQueueIndex}
      />
    </div>
  );
}
