import { useState, useEffect, useRef, useCallback } from "react";
import type { RendererProps } from "./index";
import type { LyricsData } from "../../types/informationTypes";

interface LrcLine {
  time: number;
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
      if (text) lines.push({ time: mins * 60 + secs, text });
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

export function LyricsRenderer({ data, onAction, context }: RendererProps) {
  const d = data as LyricsData;

  // All hooks MUST be called before any conditional return (React rules of hooks)
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [editKind, setEditKind] = useState<"plain" | "synced">("plain");
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [userScrolled, setUserScrolled] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeLineRef = useRef<HTMLDivElement>(null);
  const userScrollTimeout = useRef<number>(0);

  const positionSecs = context?.positionSecs ?? 0;
  const lrcLines = d?.kind === "synced" && d?.text ? parseLrc(d.text) : null;
  const currentLineIdx = lrcLines ? getCurrentLineIndex(lrcLines, positionSecs) : -1;

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

  // Early return AFTER all hooks
  if (!d?.text) return null;

  const startEdit = () => {
    setEditText(d.text);
    setEditKind((d.kind as "plain" | "synced") ?? "plain");
    setEditing(true);
  };

  const handleSave = () => {
    if (onAction) onAction("save-lyrics", { text: editText, kind: editKind });
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="renderer-lyrics">
        <div className="lyrics-actions">
          <select value={editKind} onChange={e => setEditKind(e.target.value as "plain" | "synced")}>
            <option value="plain">Plain</option>
            <option value="synced">Synced (LRC)</option>
          </select>
          <button className="lyrics-action-btn" onClick={handleSave}>Save</button>
          <button className="lyrics-action-btn" onClick={() => setEditing(false)}>Cancel</button>
        </div>
        <textarea
          className="lyrics-editor"
          value={editText}
          onChange={e => setEditText(e.target.value)}
          spellCheck={false}
        />
      </div>
    );
  }

  return (
    <div className="renderer-lyrics">
      <div className="lyrics-actions">
        <span className={`lyrics-badge${d.kind === "synced" ? " lyrics-badge-synced" : ""}`}>
          {d.kind}
        </span>
        {lrcLines && positionSecs > 0 && (
          <button
            className={`lyrics-action-btn${syncEnabled ? " active" : ""}`}
            onClick={() => setSyncEnabled(v => !v)}
            title={syncEnabled ? "Disable synced scroll" : "Enable synced scroll"}
          >&#9201;</button>
        )}
        <button className="lyrics-action-btn" onClick={startEdit} title="Edit lyrics">&#9998;</button>
      </div>
      <div className="lyrics-body" ref={scrollRef} onScroll={handleScroll}>
        {lrcLines ? (
          lrcLines.map((line, i) => (
            <div
              key={i}
              ref={i === currentLineIdx ? activeLineRef : undefined}
              className={`lyrics-line${i === currentLineIdx ? " lyrics-line-active" : ""}`}
            >
              {line.text}
            </div>
          ))
        ) : (
          <div className="lyrics-plain">{d.text}</div>
        )}
      </div>
    </div>
  );
}
