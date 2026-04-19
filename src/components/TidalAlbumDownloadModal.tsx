import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { tidalCoverUrl } from "../utils";
import type { AppStore } from "../store";
import "./TidalDownloadModal.css";

export interface TidalAlbumDownloadInput {
  albumId: string;
  title: string;
  artistName: string | null;
  coverId: string | null;
  trackCount: number;
}

interface TidalAlbumDownloadModalProps {
  input: TidalAlbumDownloadInput;
  downloadFormat: string;
  collections: { id: number; name: string; path: string }[];
  store: AppStore;
  lastDest: string | null;
  onClose: () => void;
  onComplete: (message: string) => void;
}

const PATH_PATTERNS = [
  { value: "[artist]/[album]/[track_number] - [title]", label: "Artist / Album / 01 - Title" },
  { value: "[artist] - [album]/[track_number] - [title]", label: "Artist - Album / 01 - Title" },
  { value: "[artist]/[album]/[artist] - [track_number] - [title]", label: "Artist / Album / Artist - 01 - Title" },
  { value: "[artist] - [album] - [track_number] - [title]", label: "Artist - Album - 01 - Title (flat)" },
];

function previewPattern(pattern: string, artist: string, album: string, ext: string): string {
  return pattern
    .replace(/\[artist\]/g, artist || "Artist")
    .replace(/\[album\]/g, album || "Album")
    .replace(/\[track_number\]/g, "01")
    .replace(/\[title\]/g, "Track Name")
    + "." + ext;
}

type TrackStatus = "queued" | "downloading" | "done" | "error";

interface TrackProgress {
  id: number;
  title: string;
  artist: string;
  status: TrackStatus;
  progress: number;
  error?: string;
}

type Step = "configure" | "downloading" | "done";

export function TidalAlbumDownloadModal({
  input,
  downloadFormat,
  collections,
  store,
  lastDest,
  onClose,
  onComplete,
}: TidalAlbumDownloadModalProps) {
  const [step, setStep] = useState<Step>("configure");
  const [quality, setQuality] = useState<"flac" | "aac">(
    downloadFormat === "flac" ? "flac" : "aac"
  );
  const [destType, setDestType] = useState<"collection" | "path">("collection");
  const [destCollectionId, setDestCollectionId] = useState<number | null>(() => {
    if (lastDest) {
      const parsed = parseInt(lastDest, 10);
      if (!isNaN(parsed) && collections.some(c => c.id === parsed)) return parsed;
    }
    return collections.length > 0 ? collections[0].id : null;
  });
  const [destPath, setDestPath] = useState<string | null>(null);
  const [pathPattern, setPathPattern] = useState(PATH_PATTERNS[0].value);
  const [error, setError] = useState<string | null>(null);
  const [tracks, setTracks] = useState<TrackProgress[]>([]);
  const trackIdsRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (step !== "downloading") return;
    const unsubs: Promise<() => void>[] = [];

    unsubs.push(listen<{ id: number; track_title: string; artist_name: string; status: string; progress_pct: number }>("download-progress", (event) => {
      const p = event.payload;
      if (!trackIdsRef.current.has(p.id)) return;
      setTracks(prev => prev.map(t =>
        t.id === p.id ? { ...t, status: "downloading" as TrackStatus, progress: p.progress_pct } : t
      ));
    }));

    unsubs.push(listen<{ id: number; trackTitle: string; destPath: string }>("download-complete", (event) => {
      const p = event.payload;
      if (!trackIdsRef.current.has(p.id)) return;
      setTracks(prev => {
        const next = prev.map(t =>
          t.id === p.id ? { ...t, status: "done" as TrackStatus, progress: 100 } : t
        );
        if (next.every(t => t.status === "done" || t.status === "error")) {
          setStep("done");
        }
        return next;
      });
    }));

    unsubs.push(listen<{ id: number; trackTitle: string; error: string }>("download-error", (event) => {
      const p = event.payload;
      if (!trackIdsRef.current.has(p.id)) return;
      setTracks(prev => {
        const next = prev.map(t =>
          t.id === p.id ? { ...t, status: "error" as TrackStatus, error: p.error } : t
        );
        if (next.every(t => t.status === "done" || t.status === "error")) {
          setStep("done");
        }
        return next;
      });
    }));

    return () => { unsubs.forEach(p => p.then(fn => fn())); };
  }, [step]);

  async function handleBrowseFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      setDestType("path");
      setDestPath(selected);
      setDestCollectionId(null);
    }
  }

  async function handleDownload() {
    setError(null);

    const collId = destType === "collection" ? destCollectionId : null;
    const customPath = destType === "path" ? destPath : null;

    if (!collId && !customPath) {
      setError("Please select a destination");
      return;
    }

    store.set("lastTidalDownloadDest", collId != null ? String(collId) : null);

    try {
      const ids = await invoke<number[]>("download_album", {
        albumId: input.albumId,
        destCollectionId: collId,
        customDestPath: customPath,
        format: quality,
        pathPattern: pathPattern,
      });

      const idSet = new Set(ids);
      trackIdsRef.current = idSet;

      const status = await invoke<{ active: { id: number; track_title: string; artist_name: string } | null; queued: Array<{ id: number; track_title: string; artist_name: string }> }>("get_download_status");
      const allItems = [
        ...(status.active ? [status.active] : []),
        ...status.queued,
      ].filter(s => idSet.has(s.id));

      setTracks(allItems.map(s => ({
        id: s.id,
        title: s.track_title,
        artist: s.artist_name,
        status: "queued",
        progress: 0,
      })));
      setStep("downloading");
    } catch (e) {
      setError(String(e));
    }
  }

  const coverUrl = tidalCoverUrl(input.coverId, 320);
  const preview = previewPattern(pathPattern, input.artistName ?? "Artist", input.title, quality === "flac" ? "flac" : "m4a");

  const doneCount = tracks.filter(t => t.status === "done").length;
  const errorCount = tracks.filter(t => t.status === "error").length;
  const totalPct = tracks.length > 0
    ? Math.round(tracks.reduce((sum, t) => sum + t.progress, 0) / tracks.length)
    : 0;

  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal tidal-dl-modal" onClick={(e) => e.stopPropagation()} style={step !== "configure" ? { width: 440 } : undefined}>
        {step === "configure" && (
          <>
            <h2 className="ds-modal-title">Download Album</h2>

            <div className="tidal-dl-selected">
              {coverUrl && <img src={coverUrl} alt="" />}
              <div className="tidal-dl-selected-info">
                <span className="tidal-dl-result-title">{input.title}</span>
                <span className="tidal-dl-result-meta">
                  {input.artistName ?? "Unknown"} {"\u00B7"} {input.trackCount} tracks
                </span>
              </div>
            </div>

            {error && <div className="tidal-dl-error">{error}</div>}

            <div className="tidal-dl-config-row">
              <label>Quality</label>
              <select value={quality} onChange={(e) => setQuality(e.target.value as "flac" | "aac")}>
                <option value="flac">FLAC (Lossless)</option>
                <option value="aac">AAC (320kbps)</option>
              </select>
            </div>

            <div className="tidal-dl-config-row">
              <label>Save to</label>
              <select
                value={destType === "collection" ? String(destCollectionId ?? "") : "__browse__"}
                onChange={(e) => {
                  if (e.target.value === "__browse__") {
                    handleBrowseFolder();
                  } else {
                    setDestType("collection");
                    setDestCollectionId(parseInt(e.target.value, 10));
                    setDestPath(null);
                  }
                }}
              >
                {collections.map(c => (
                  <option key={c.id} value={String(c.id)}>{c.name} {"\u2014"} {c.path}</option>
                ))}
                <option value="__browse__">Browse to folder...</option>
              </select>
            </div>

            {destType === "path" && destPath && (
              <div className="tidal-dl-config-row">
                <label />
                <span className="tidal-dl-dest-display">{destPath}</span>
              </div>
            )}

            <div className="tidal-dl-config-row">
              <label>File layout</label>
              <select value={pathPattern} onChange={(e) => setPathPattern(e.target.value)}>
                {PATH_PATTERNS.map(p => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>

            <div className="tidal-dl-config-row">
              <label />
              <span className="tidal-dl-dest-display" style={{ opacity: 0.7 }}>{preview}</span>
            </div>

            <div className="tidal-dl-actions">
              <button onClick={onClose}>Cancel</button>
              <button className="tidal-dl-btn-primary" onClick={handleDownload}>
                Download {input.trackCount} Tracks
              </button>
            </div>
          </>
        )}

        {step === "downloading" && (
          <>
            <h2 className="ds-modal-title">Downloading Album</h2>

            <div className="tidal-dl-selected">
              {coverUrl && <img src={coverUrl} alt="" />}
              <div className="tidal-dl-selected-info">
                <span className="tidal-dl-result-title">{input.title}</span>
                <span className="tidal-dl-result-meta">
                  {doneCount} of {tracks.length} tracks {"\u00B7"} {totalPct}%
                </span>
              </div>
            </div>

            <div className="tidal-dl-progress">
              <div className="tidal-dl-progress-bar">
                <div className="tidal-dl-progress-fill" style={{ width: `${totalPct}%` }} />
              </div>
            </div>

            <div className="album-dl-track-list">
              {tracks.map(t => (
                <div key={t.id} className={`album-dl-track album-dl-track-${t.status}`}>
                  <span className="album-dl-track-icon">
                    {t.status === "done" ? "\u2713" : t.status === "error" ? "\u2717" : t.status === "downloading" ? "\u25BC" : "\u00B7"}
                  </span>
                  <span className="album-dl-track-title">{t.title}</span>
                  {t.status === "downloading" && (
                    <span className="album-dl-track-pct">{t.progress}%</span>
                  )}
                  {t.status === "error" && (
                    <span className="album-dl-track-error" title={t.error}>failed</span>
                  )}
                </div>
              ))}
            </div>

            <div className="tidal-dl-actions">
              <button onClick={onClose}>Cancel</button>
            </div>
          </>
        )}

        {step === "done" && (
          <>
            <h2 className="ds-modal-title">Download Complete</h2>

            <div className="tidal-dl-selected">
              {coverUrl && <img src={coverUrl} alt="" />}
              <div className="tidal-dl-selected-info">
                <span className="tidal-dl-result-title">{input.title}</span>
                <span className="tidal-dl-result-meta">
                  {doneCount} downloaded{errorCount > 0 ? `, ${errorCount} failed` : ""}
                </span>
              </div>
            </div>

            <div className="album-dl-track-list">
              {tracks.map(t => (
                <div key={t.id} className={`album-dl-track album-dl-track-${t.status}`}>
                  <span className="album-dl-track-icon">
                    {t.status === "done" ? "\u2713" : "\u2717"}
                  </span>
                  <span className="album-dl-track-title">{t.title}</span>
                  {t.status === "error" && (
                    <span className="album-dl-track-error" title={t.error}>failed</span>
                  )}
                </div>
              ))}
            </div>

            <div className="tidal-dl-actions">
              <button className="tidal-dl-btn-primary" onClick={() => onComplete(`Downloaded ${doneCount} tracks from "${input.title}"`)}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
