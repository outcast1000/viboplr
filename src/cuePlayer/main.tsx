// The cue-sheet player Vibo Community embeds on a cue sheet's page
// (`/cue-sheets/{id}/player`, in a sandboxed frame). It is the app's own
// renderer — CueClipOverlay for clips, CueOverlay for cards — driven by a
// silent clock instead of the song, so a sheet looks on the site exactly as it
// does in Now Playing. Built into one script + one stylesheet by
// `npm run build:cue-player` and vendored into the Community repo.
//
// The page hands the item in as JSON (`<script type="application/json"
// id="cue-sheet">`); nothing is fetched. The frame has an opaque origin
// (sandbox without allow-same-origin), so this code can't see the site's
// cookies, and its CSP allows https images and nothing else from outside.

import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CueClipOverlay } from "../components/CueClipOverlay";
import { CueOverlay } from "../components/CueOverlay";
import { setPlaybackPosition, usePlaybackPosition } from "../playback/positionStore";
import { clockAt, formatClock, readSheet, type PlayerSheet } from "./sheet";
import "./player.css";

function Player({ sheet }: { sheet: PlayerSheet }) {
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const position = usePlaybackPosition();
  // The clock: where it was when it last started, and when that was.
  const anchor = useRef({ from: 0, at: 0 });

  const play = useCallback(() => {
    const from = position >= sheet.length - 0.05 ? 0 : position; // at the end, Play is Replay
    anchor.current = { from, at: performance.now() };
    setPlaybackPosition(from);
    setStarted(true);
    setPlaying(true);
  }, [position, sheet.length]);
  const pause = useCallback(() => setPlaying(false), []);
  const seek = useCallback((secs: number) => {
    const to = Math.min(sheet.length, Math.max(0, secs));
    anchor.current = { from: to, at: performance.now() };
    setPlaybackPosition(to);
  }, [sheet.length]);

  useEffect(() => {
    if (!playing) return;
    let id = 0;
    const tick = () => {
      const t = clockAt(anchor.current.from, performance.now() - anchor.current.at, sheet.length);
      setPlaybackPosition(t);
      if (t >= sheet.length) { setPlaying(false); return; }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing, sheet.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement && e.key !== " ") return;
      if (e.key === " " || e.key === "k") { e.preventDefault(); if (playing) pause(); else play(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); seek(position + 5); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); seek(position - 5); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing, play, pause, seek, position]);

  const ended = started && !playing && position >= sheet.length - 0.05;
  return (
    <div className="cp">
      <div className={`cp-stage cp-stage--${sheet.mode}`} onClick={() => (playing ? pause() : play())}>
        {sheet.mode === "clip" ? (
          <CueClipOverlay cues={sheet.cues} camera={sheet.camera} beats={sheet.beats} playing={playing} author={sheet.author} timingNote={null} />
        ) : (
          <div className="cp-art"><CueOverlay cues={sheet.cues} author={sheet.author} timingNote={null} /></div>
        )}
        {(!started || ended) && (
          <div className="cp-start">
            <button type="button" className="cp-big-play" aria-label={ended ? "Play again" : "Play the clip"} onClick={(e) => { e.stopPropagation(); play(); }}>
              <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>
            </button>
            <div className="cp-start-title">{sheet.artistName ? `${sheet.artistName} — ${sheet.title}` : sheet.title}</div>
            <div className="cp-start-note">Silent preview · the clip runs on its own clock. Open it in Vibo to see it with the song.</div>
          </div>
        )}
      </div>
      <div className="cp-bar">
        <button type="button" className="cp-btn" aria-label={playing ? "Pause" : "Play"} onClick={() => (playing ? pause() : play())}>
          {playing ? (
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7 5h4v14H7zm6 0h4v14h-4z" fill="currentColor" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>
          )}
        </button>
        <input
          className="cp-seek"
          type="range"
          min={0}
          max={sheet.length}
          step={0.1}
          value={Math.min(position, sheet.length)}
          aria-label="Position"
          onChange={(e) => seek(Number(e.target.value))}
        />
        <span className="cp-time">{formatClock(position)} / {formatClock(sheet.length)}</span>
      </div>
    </div>
  );
}

function mount() {
  const root = document.getElementById("cue-player");
  const data = document.getElementById("cue-sheet")?.textContent ?? "";
  if (!root) return;
  let sheet: PlayerSheet | null = null;
  try {
    sheet = readSheet(JSON.parse(data));
  } catch (e) {
    console.error("Failed to read the cue sheet:", e);
  }
  if (!sheet) {
    root.textContent = "This cue sheet has nothing to play.";
    root.className = "cp-empty";
    return;
  }
  setPlaybackPosition(0);
  createRoot(root).render(<StrictMode><Player sheet={sheet} /></StrictMode>);
}

mount();
