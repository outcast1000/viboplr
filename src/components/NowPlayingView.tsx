import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { isVideoTrack, getInitials } from "../utils";
import type { QueueTrack } from "../types";
import type { LyricsData } from "../types/informationTypes";
import type { UseLyricsResult } from "../hooks/useLyrics";
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
            <NowPlayingLyrics data={lyrics.data} positionSecs={positionSecs} onSeek={onSeek} />
          ) : lyrics.status === "loading" ? (
            <div className="np-lyrics-hint" aria-hidden="true" />
          ) : null}
        </div>
      </div>
      {metaLine}
      {track && trackTags.length > 0 && (
        <div className="np-tags">{trackTags.join(" · ")}</div>
      )}
    </div>
  );
}
