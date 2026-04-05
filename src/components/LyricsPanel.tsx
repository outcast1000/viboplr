import { useState, useEffect, useRef, useCallback } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

interface LyricsPanelProps {
  trackId: number;
  artistName: string;
  title: string;
  positionSecs: number;
  lyrics: { text: string; kind: string; provider: string } | null;
  loading: boolean;
  onSave: (text: string, kind: string) => void;
  onReset: () => void;
  onForceRefresh: () => void;
}

interface LrcLine {
  time: number; // seconds
  text: string;
}

function parseLrc(lrc: string): LrcLine[] {
  const lines: LrcLine[] = [];
  for (const line of lrc.split("\n")) {
    const match = line.match(/^\[(\d{2}):(\d{2})[.:]\d{2,3}\](.*)$/);
    if (match) {
      const mins = parseInt(match[1], 10);
      const secs = parseInt(match[2], 10);
      const text = match[3].trim();
      if (text) {
        lines.push({ time: mins * 60 + secs, text });
      }
    }
  }
  return lines;
}

function getCurrentLineIndex(lines: LrcLine[], position: number): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= position) idx = i;
    else break;
  }
  return idx;
}

export default function LyricsPanel({ trackId, artistName, title, positionSecs, lyrics, loading, onSave, onReset, onForceRefresh }: LyricsPanelProps) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [editKind, setEditKind] = useState<"plain" | "synced">("plain");
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [userScrolled, setUserScrolled] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeLineRef = useRef<HTMLDivElement>(null);
  const userScrollTimeout = useRef<number>(0);

  // Reset edit state when track changes
  useEffect(() => {
    setEditing(false);
    setUserScrolled(false);
  }, [trackId]);

  // Parse synced lyrics
  const lrcLines = lyrics?.kind === "synced" ? parseLrc(lyrics.text) : null;
  const currentLineIdx = lrcLines ? getCurrentLineIndex(lrcLines, positionSecs) : -1;

  // Auto-scroll to current line
  useEffect(() => {
    if (syncEnabled && !userScrolled && activeLineRef.current && scrollRef.current) {
      activeLineRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [currentLineIdx, userScrolled, syncEnabled]);

  const handleScroll = useCallback(() => {
    setUserScrolled(true);
    if (userScrollTimeout.current) clearTimeout(userScrollTimeout.current);
    userScrollTimeout.current = window.setTimeout(() => setUserScrolled(false), 5000);
  }, []);

  const startEdit = () => {
    setEditText(lyrics?.text ?? "");
    setEditKind((lyrics?.kind as "plain" | "synced") ?? "plain");
    setEditing(true);
  };

  const handleSave = () => {
    onSave(editText, editKind);
    setEditing(false);
  };

  const handleSearchWeb = () => {
    const q = encodeURIComponent(`${artistName} - ${title} lyrics`);
    openUrl(`https://www.google.com/search?q=${q}`);
  };

  const handlePasteAppend = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      const current = lyrics?.text ?? "";
      const merged = current ? current + "\n" + text : text;
      onSave(merged, "plain");
    } catch { /* clipboard access denied */ }
  };

  if (loading) {
    return (
      <div>
        <div className="track-detail-section-title">Lyrics</div>
        <div className="np-lyrics-actions">
          <button className="np-lyrics-btn" onClick={handleSearchWeb} title="Search lyrics on web">🔍</button>
          <button className="np-lyrics-btn" onClick={handlePasteAppend} title="Paste lyrics from clipboard">📋</button>
        </div>
        <div className="track-detail-empty">Loading…</div>
      </div>
    );
  }

  if (editing) {
    return (
      <div>
        <div className="track-detail-section-title">Edit Lyrics</div>
        <div className="np-lyrics-actions">
          <select value={editKind} onChange={e => setEditKind(e.target.value as "plain" | "synced")}>
            <option value="plain">Plain</option>
            <option value="synced">Synced (LRC)</option>
          </select>
          <button className="np-lyrics-btn" onClick={handleSave}>Save</button>
          <button className="np-lyrics-btn" onClick={() => setEditing(false)}>Cancel</button>
        </div>
        <textarea
          className="np-lyrics-editor"
          value={editText}
          onChange={e => setEditText(e.target.value)}
          spellCheck={false}
        />
      </div>
    );
  }

  if (!lyrics) {
    return (
      <div>
        <div className="track-detail-section-title">Lyrics</div>
        <div className="np-lyrics-actions">
          <button className="np-lyrics-btn" onClick={handleSearchWeb} title="Search lyrics on web">🔍</button>
          <button className="np-lyrics-btn" onClick={handlePasteAppend} title="Paste lyrics from clipboard">📋</button>
          <button className="np-lyrics-btn" onClick={startEdit} title="Add lyrics manually">✎</button>
        </div>
        <div className="track-detail-empty">No lyrics found</div>
      </div>
    );
  }

  return (
    <div>
      <div className="track-detail-section-title">Lyrics</div>
      <div className="np-lyrics-actions">
        <span className={`np-lyrics-badge ${lyrics.kind === "synced" ? "np-lyrics-badge-synced" : ""}`}>
          {lyrics.kind}
        </span>
        {lrcLines && (
          <button
            className={`np-lyrics-btn${syncEnabled ? " np-lyrics-btn-active" : ""}`}
            onClick={() => setSyncEnabled(v => !v)}
            title={syncEnabled ? "Disable synced auto-scroll" : "Enable synced auto-scroll"}
          >⏱</button>
        )}
        <button className="np-lyrics-btn" onClick={handleSearchWeb} title="Search lyrics on web">🔍</button>
        <button className="np-lyrics-btn" onClick={handlePasteAppend} title="Paste and append lyrics from clipboard">📋</button>
        <button className="np-lyrics-btn" onClick={startEdit} title="Edit lyrics">✎</button>
        {lyrics.provider === "manual" && (
          <button className="np-lyrics-btn" onClick={onReset} title="Reset to provider lyrics">↺</button>
        )}
        {lyrics.provider !== "manual" && (
          <button className="np-lyrics-btn" onClick={onForceRefresh} title="Re-fetch lyrics">↻</button>
        )}
      </div>
      <div className="np-lyrics-body" ref={scrollRef} onScroll={handleScroll}>
        {lrcLines ? (
          lrcLines.map((line, i) => (
            <div
              key={i}
              ref={i === currentLineIdx ? activeLineRef : undefined}
              className={`np-lyrics-line ${i === currentLineIdx ? "np-lyrics-line-active" : ""}`}
            >
              {line.text}
            </div>
          ))
        ) : (
          <div className="np-lyrics-plain">{lyrics.text}</div>
        )}
      </div>
      <div className="np-lyrics-footer">
        via {lyrics.provider}
      </div>
    </div>
  );
}
