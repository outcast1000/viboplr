import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { track as trackTelemetry } from "../telemetry";
import { save, open } from "@tauri-apps/plugin-dialog";
import { subscribe, combineUnlisten } from "../utils/tauriEvents";
import { useState, useEffect, useCallback } from "react";
import { formatDuration, formatFileSize } from "../utils";
import { MIXTAPE_FORMAT_LADDER, MIXTAPE_FORMAT_DEFAULT } from "../utils/mixtapeFormatLadder";
import "./Mixtape.css";

export interface ExportTrack {
  id?: number;
  title: string;
  artistName?: string;
  albumTitle?: string;
  durationSecs?: number;
  fileSize?: number;
  path?: string;
  imageUrl?: string;
}

interface MixtapeExportModalProps {
  tracks: ExportTrack[];
  defaultTitle?: string;
  defaultCoverPath?: string | null;
  defaultMetadata?: Record<string, string> | null;
  defaultMixtapeType?: MixtapeType;
  onClose: () => void;
}

type MixtapeType = "custom" | "album" | "best_of_artist";
type ExportMode = "playlist" | "full";
type ExportTab = "details" | "metadata" | "tracks";

interface MixtapeExportProgress {
  currentTrack: number;
  totalTracks: number;
  phase: string;
  trackTitle: string;
}

function trackStatus(t: ExportTrack): "local" | "remote" | "unknown" {
  if (!t.path) return "unknown";
  if (t.path.startsWith("file://")) return "local";
  return "remote";
}


const RECOMMENDED_METADATA_KEYS = [
  { key: "liner_notes", label: "Liner Notes" },
  { key: "quality", label: "Quality" },
  { key: "source", label: "Source" },
  { key: "genre", label: "Genre" },
  { key: "mood", label: "Mood" },
  { key: "occasion", label: "Occasion" },
  { key: "year", label: "Year" },
  { key: "bpm", label: "BPM" },
  { key: "notes", label: "Notes" },
];

const SOURCE_LABELS: Record<string, string> = {
  subsonic: "Subsonic",
};

function formatPhase(phase: string): string {
  if (phase === "packing") return "Packing";
  const [action, source] = phase.split(":");
  if (action === "resolving" || action === "downloading") {
    const label = (source && SOURCE_LABELS[source]) || source || "";
    return label ? `Downloading from ${label}` : "Downloading";
  }
  return "Packing";
}


export function MixtapeExportModal({ tracks, defaultTitle, defaultCoverPath, defaultMetadata, defaultMixtapeType, onClose }: MixtapeExportModalProps) {
  const [title, setTitle] = useState(defaultTitle || "");
  const [maxFormat, setMaxFormat] = useState<string>(MIXTAPE_FORMAT_DEFAULT);
  const [mixtapeType, setMixtapeType] = useState<MixtapeType>(defaultMixtapeType || "custom");
  const [coverPath, setCoverPath] = useState<string | null>(defaultCoverPath ?? null);
  const [includeThumb, setIncludeThumb] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<string | null>(null);
  const [progress, setProgress] = useState<MixtapeExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const trackList = tracks;
  const [exportMode, setExportMode] = useState<ExportMode>("full");
  const [activeTab, setActiveTab] = useState<ExportTab>("details");
  const [metadataEntries, setMetadataEntries] = useState<{ key: string; value: string }[]>(() => {
    const entries: { key: string; value: string }[] = [];
    if (defaultMetadata) {
      for (const [k, v] of Object.entries(defaultMetadata)) {
        if (v) entries.push({ key: k, value: v });
      }
    }
    if (!entries.some(e => e.key === "liner_notes")) {
      entries.push({ key: "liner_notes", value: "" });
    }
    return entries;
  });

  const estimatedSize = trackList.reduce((sum, t) => sum + (t.fileSize || 0), 0);

  const handleCoverChoose = useCallback(async () => {
    const result = await open({
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }],
    });
    if (result) {
      setCoverPath(result);
    }
  }, []);

  const handleCoverPaste = useCallback(async () => {
    try {
      const path = await invoke<string>("paste_clipboard_to_playlist_images");
      setCoverPath(path);
    } catch (err) {
      setError(`Failed to paste image: ${err}`);
    }
  }, []);

  const handleCoverRemove = useCallback(() => {
    setCoverPath(null);
  }, []);

  const handleMetadataKeyChange = useCallback((idx: number, newKey: string) => {
    setMetadataEntries(prev => prev.map((e, i) => i === idx ? { ...e, key: newKey } : e));
  }, []);

  const handleMetadataValueChange = useCallback((idx: number, newValue: string) => {
    setMetadataEntries(prev => prev.map((e, i) => i === idx ? { ...e, value: newValue } : e));
  }, []);

  const handleMetadataKeyBlur = useCallback((idx: number) => {
    setMetadataEntries(prev => prev.map((e, i) => {
      if (i !== idx) return e;
      return { ...e, key: e.key.trim().toLowerCase().replace(/\s+/g, "_") };
    }));
  }, []);

  const handleRemoveMetadata = useCallback((idx: number) => {
    setMetadataEntries(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const handleAddMetadata = useCallback(() => {
    setMetadataEntries(prev => [...prev, { key: "", value: "" }]);
  }, []);

  const handleExport = useCallback(async () => {
    if (!title.trim()) {
      setError("Please enter a title");
      return;
    }

    const seen = new Set<string>();
    for (const entry of metadataEntries) {
      const key = entry.key.trim().toLowerCase().replace(/\s+/g, "_");
      if (key && seen.has(key)) {
        setError("Duplicate metadata keys are not allowed");
        return;
      }
      if (key) seen.add(key);
    }

    const destPath = await save({
      filters: [{ name: "Mixtape", extensions: ["mixtape"] }],
      defaultPath: `${title}.mixtape`,
    });

    if (!destPath) return;

    setExporting(true);
    setProgress(null);
    setError(null);

    try {
      const metadata: Record<string, string> = {};
      for (const entry of metadataEntries) {
        const key = entry.key.trim().toLowerCase().replace(/\s+/g, "_");
        if (key && entry.value.trim()) {
          metadata[key] = entry.value.trim();
        }
      }

      if (exportMode === "playlist") {
        const trackMeta = trackList.map(t => ({
          title: t.title,
          artist: t.artistName || null,
          album: t.albumTitle || null,
          durationSecs: t.durationSecs || null,
          imageUrl: t.imageUrl || null,
        }));
        await invoke("export_mixtape_playlist_only", {
          destPath,
          options: {
            title: title.trim(),
            mixtapeType,
            metadata,
            createdBy: null,
            coverImagePath: coverPath,
            includeThumbs: includeThumb,
            tracks: trackMeta,
          },
        });
      } else {
        const trackInputs = trackList.map(t => ({
          id: t.id || null,
          title: t.title,
          artist: t.artistName || null,
          album: t.albumTitle || null,
          durationSecs: t.durationSecs || null,
          path: t.path || null,
          imageUrl: t.imageUrl || null,
        }));
        await invoke("export_mixtape_full", {
          destPath,
          options: {
            title: title.trim(),
            mixtapeType,
            metadata,
            createdBy: null,
            coverImagePath: coverPath,
            includeThumbs: includeThumb,
            tracks: trackInputs,
            format: maxFormat,
          },
        });
      }
      trackTelemetry("playlist_saved", { format: "mixtape", mode: exportMode });
    } catch (err) {
      setError(`Export failed: ${err}`);
      setExporting(false);
    }
  }, [title, metadataEntries, mixtapeType, coverPath, includeThumb, trackList, exportMode, maxFormat]);

  const handleCancel = useCallback(() => {
    if (exporting) {
      invoke("cancel_mixtape_operation").catch(console.error);
    }
    onClose();
  }, [exporting, onClose]);

  useEffect(() => {
    const stopProgress = subscribe<MixtapeExportProgress>("mixtape-export-progress", (event) => {
      setProgress(event.payload);
    });

    const stopComplete = subscribe<{ path: string; fileSize: number; skipped?: string[] }>("mixtape-export-complete", (event) => {
      setExporting(false);
      const { fileSize, skipped } = event.payload;
      const sizeMb = (fileSize / (1024 * 1024)).toFixed(1);
      let msg = `Mixtape exported (${sizeMb} MB)`;
      if (skipped && skipped.length > 0) {
        msg += ` — ${skipped.length} track${skipped.length > 1 ? "s" : ""} skipped`;
      }
      setExportResult(msg);
    });

    const stopError = subscribe<{ message: string } | string>("mixtape-export-error", (event) => {
      const payload = event.payload;
      setError(typeof payload === "string" ? payload : payload?.message ?? "Export failed");
      setExporting(false);
    });

    return combineUnlisten(stopProgress, stopComplete, stopError);
  }, [onClose]);

  const mixtapeTypeLabel = (type: MixtapeType): string => {
    switch (type) {
      case "custom": return "Mixtape";
      case "album": return "Album";
      case "best_of_artist": return "Best Of";
    }
  };

  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal mixtape-export-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="ds-modal-title">Export Mixtape</h2>

        {exportResult ? (
          <div className="mixtape-progress">
            <p style={{ textAlign: "center", color: "var(--success)", margin: "16px 0" }}>{exportResult}</p>
            <div className="mixtape-preview-actions">
              <button className="mixtape-action-btn primary" onClick={onClose}>Done</button>
            </div>
          </div>
        ) : !exporting ? (
          <>
            <div className="ds-tabs ds-tabs--compact" style={{ padding: "0 16px" }}>
              <button className={`ds-tab${activeTab === "details" ? " active" : ""}`} onClick={() => setActiveTab("details")}>Details</button>
              <button className={`ds-tab${activeTab === "metadata" ? " active" : ""}`} onClick={() => setActiveTab("metadata")}>Metadata</button>
              <button className={`ds-tab${activeTab === "tracks" ? " active" : ""}`} onClick={() => setActiveTab("tracks")}>
                Tracks
                <span className="ds-tab-badge">{trackList.length}</span>
              </button>
            </div>

            {activeTab === "details" ? (
              <div className="mixtape-export-form">
                <div className="mixtape-export-cover-section">
                  {coverPath ? (
                    <img className="mixtape-export-cover-preview" src={convertFileSrc(coverPath)} alt="Cover" />
                  ) : (
                    <div className="mixtape-export-cover-placeholder" onClick={handleCoverChoose}>No cover</div>
                  )}
                  <div className="mixtape-export-cover-actions">
                    <button onClick={handleCoverChoose}>Choose</button>
                    <button onClick={handleCoverPaste}>Paste</button>
                    {coverPath && <button onClick={handleCoverRemove}>Remove</button>}
                  </div>
                </div>

                <div className="mixtape-export-fields">
                  <label>
                    Title
                    <input
                      type="text"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="Mixtape title"
                      autoFocus
                    />
                  </label>
                  <div className="mixtape-export-mode">
                    <label>Export mode</label>
                    <div className="mixtape-export-mode-options">
                      <button className={`mixtape-mode-btn${exportMode === "full" ? " active" : ""}`} onClick={() => setExportMode("full")}>Full (with audio)</button>
                      <button className={`mixtape-mode-btn${exportMode === "playlist" ? " active" : ""}`} onClick={() => setExportMode("playlist")}>Playlist only</button>
                    </div>
                    {exportMode === "full" && trackList.some(t => trackStatus(t) !== "local") && (
                      <p className="mixtape-export-hint">{trackList.filter(t => trackStatus(t) !== "local").length} remote track{trackList.filter(t => trackStatus(t) !== "local").length > 1 ? "s" : ""} will be downloaded during export</p>
                    )}
                    {exportMode === "playlist" && (
                      <p className="mixtape-export-hint">Track list and cover only — no audio files</p>
                    )}
                  </div>
                  {exportMode === "full" && trackList.some(t => trackStatus(t) !== "local") && (
                    <div className="mixtape-export-row">
                      <label>
                        Max preferred format
                        <select value={maxFormat} onChange={(e) => setMaxFormat(e.target.value)}>
                          {MIXTAPE_FORMAT_LADDER.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                  <div className="mixtape-export-row">
                    <label>
                      Type
                      <select value={mixtapeType} onChange={(e) => setMixtapeType(e.target.value as MixtapeType)}>
                        <option value="custom">{mixtapeTypeLabel("custom")}</option>
                        <option value="album">{mixtapeTypeLabel("album")}</option>
                        <option value="best_of_artist">{mixtapeTypeLabel("best_of_artist")}</option>
                      </select>
                    </label>
                  </div>
                  <label className="mixtape-export-checkbox">
                    <input
                      type="checkbox"
                      checked={includeThumb}
                      onChange={(e) => setIncludeThumb(e.target.checked)}
                    />
                    Include track thumbnails
                  </label>
                </div>
              </div>
            ) : activeTab === "metadata" ? (
              <div className="mixtape-export-form">
                <div className="mixtape-export-fields" style={{ flex: 1 }}>
                  <div className="mixtape-metadata-editor">
                    <label>Metadata</label>
                    {metadataEntries.map((entry, idx) => {
                      const isDuplicate = metadataEntries.some((e, i) => i !== idx && e.key === entry.key && entry.key !== "");
                      return (
                        <div key={idx} className="mixtape-metadata-row">
                          <input
                            type="text"
                            value={entry.key}
                            onChange={(e) => handleMetadataKeyChange(idx, e.target.value)}
                            onBlur={() => handleMetadataKeyBlur(idx)}
                            placeholder="Key"
                            className={isDuplicate ? "mixtape-metadata-error" : ""}
                          />
                          <input
                            type="text"
                            value={entry.value}
                            onChange={(e) => handleMetadataValueChange(idx, e.target.value)}
                            placeholder="Value"
                          />
                          <button className="mixtape-metadata-remove" onClick={() => handleRemoveMetadata(idx)}>x</button>
                        </div>
                      );
                    })}
                    <select
                      className="mixtape-metadata-add-select"
                      value=""
                      onChange={(e) => {
                        const key = e.target.value;
                        if (key === "__custom__") {
                          handleAddMetadata();
                        } else if (key) {
                          setMetadataEntries(prev => [...prev, { key, value: "" }]);
                        }
                      }}
                    >
                      <option value="">+ Add field</option>
                      {RECOMMENDED_METADATA_KEYS
                        .filter(rec => !metadataEntries.some(e => e.key === rec.key))
                        .map(rec => (
                          <option key={rec.key} value={rec.key}>{rec.label}</option>
                        ))}
                      <option value="__custom__">Custom...</option>
                    </select>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mixtape-export-tracklist">
                <div className="mixtape-export-tracklist-header">
                  <span>{trackList.length} tracks</span>
                  {exportMode === "full" && estimatedSize > 0 && <span>~{formatFileSize(estimatedSize)}</span>}
                </div>
                {trackList.map((track, idx) => (
                  <div
                    key={track.id ?? `track-${idx}`}
                    className="mixtape-export-track"
                  >
                    <span className="mixtape-track-num">{idx + 1}</span>
                    {track.imageUrl && (
                      <img
                        className="mixtape-track-thumb"
                        src={track.imageUrl.startsWith("http") ? track.imageUrl : convertFileSrc(track.imageUrl)}
                        alt=""
                      />
                    )}
                    <div className="mixtape-track-info">
                      <span className="mixtape-track-title">{track.title}</span>
                      <span className="mixtape-track-artist">
                        {track.artistName}{track.albumTitle ? ` · ${track.albumTitle}` : ""}
                      </span>
                    </div>
                    <span className="mixtape-track-duration">{formatDuration(track.durationSecs)}</span>
                  </div>
                ))}
              </div>
            )}

            {error && <p className="mixtape-preview-error">{error}</p>}

            <div className="mixtape-preview-actions">
              <button className="mixtape-action-btn primary" onClick={handleExport} disabled={!title.trim()}>
                Export Mixtape
              </button>
              <button className="mixtape-action-btn cancel" onClick={handleCancel}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div className="mixtape-progress">
            <div className="mixtape-progress-bar">
              <div
                className="mixtape-progress-fill"
                style={{
                  width: progress
                    ? `${(progress.currentTrack / progress.totalTracks) * 100}%`
                    : "0%",
                }}
              />
            </div>
            <div className="mixtape-progress-text">
              {progress
                ? `${formatPhase(progress.phase)} ${progress.currentTrack} of ${progress.totalTracks}: ${progress.trackTitle}...`
                : "Starting export..."}
            </div>
            <button className="mixtape-cancel-btn" onClick={handleCancel}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
