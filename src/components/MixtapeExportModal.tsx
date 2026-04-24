import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { useState, useEffect, useCallback } from "react";

export interface ExportTrack {
  id: number;
  title: string;
  artistName?: string;
  albumTitle?: string;
  durationSecs?: number;
  fileSize?: number;
}

interface MixtapeExportModalProps {
  tracks: ExportTrack[];
  defaultTitle?: string;
  onClose: () => void;
}

type MixtapeType = "custom" | "album" | "best_of_artist";
type Quality = "flac" | "mp3_320" | "mp3_128" | "aac";

interface MixtapeExportProgress {
  current_track: number;
  total_tracks: number;
  bytes_written: number;
}

const formatDuration = (secs?: number): string => {
  if (!secs) return "\u2014";
  const mins = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${mins}:${s.toString().padStart(2, "0")}`;
};

const formatFileSize = (bytes?: number): string => {
  if (!bytes) return "\u2014";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
};

export function MixtapeExportModal({ tracks, defaultTitle, onClose }: MixtapeExportModalProps) {
  const [title, setTitle] = useState(defaultTitle || "");
  const [mixtapeType, setMixtapeType] = useState<MixtapeType>("custom");
  const [quality, setQuality] = useState<Quality>("flac");
  const [coverPath, setCoverPath] = useState<string | null>(null);
  const [includeThumb, setIncludeThumb] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<MixtapeExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trackList, setTrackList] = useState<ExportTrack[]>(tracks);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [metadataEntries, setMetadataEntries] = useState<{ key: string; value: string }[]>([
    { key: "quality", value: "flac" },
    { key: "liner_notes", value: "" },
  ]);

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

  const handleDragStart = useCallback((idx: number) => {
    setDragIdx(idx);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault();
    if (dragIdx === null || dragIdx === idx) return;

    setTrackList((prev) => {
      const next = [...prev];
      const [item] = next.splice(dragIdx, 1);
      next.splice(idx, 0, item);
      return next;
    });
    setDragIdx(idx);
  }, [dragIdx]);

  const handleDragEnd = useCallback(() => {
    setDragIdx(null);
  }, []);

  const handleQualityChange = useCallback((newQuality: Quality) => {
    setQuality(newQuality);
    setMetadataEntries(prev => prev.map(e => e.key === "quality" ? { ...e, value: newQuality } : e));
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

      const options = {
        title: title.trim(),
        mixtapeType: mixtapeType,
        metadata,
        createdBy: null,
        coverImagePath: coverPath,
        includeThumbs: includeThumb,
        trackIds: trackList.map((t) => t.id),
      };

      await invoke("export_mixtape", { destPath, options });
    } catch (err) {
      setError(`Export failed: ${err}`);
      setExporting(false);
    }
  }, [title, metadataEntries, mixtapeType, quality, coverPath, includeThumb, trackList]);

  const handleCancel = useCallback(() => {
    if (exporting) {
      invoke("cancel_mixtape_operation").catch(console.error);
    }
    onClose();
  }, [exporting, onClose]);

  useEffect(() => {
    const unlistenProgress = listen<MixtapeExportProgress>("mixtape-export-progress", (event) => {
      setProgress(event.payload);
    });

    const unlistenComplete = listen("mixtape-export-complete", () => {
      setExporting(false);
      onClose();
    });

    const unlistenError = listen<string>("mixtape-export-error", (event) => {
      setError(event.payload);
      setExporting(false);
    });

    return () => {
      unlistenProgress.then((fn) => fn());
      unlistenComplete.then((fn) => fn());
      unlistenError.then((fn) => fn());
    };
  }, [onClose]);

  const mixtapeTypeLabel = (type: MixtapeType): string => {
    switch (type) {
      case "custom": return "Mixtape";
      case "album": return "Album";
      case "best_of_artist": return "Best Of";
    }
  };

  const qualityLabel = (q: Quality): string => {
    switch (q) {
      case "flac": return "FLAC (lossless)";
      case "mp3_320": return "MP3 320kbps";
      case "mp3_128": return "MP3 128kbps";
      case "aac": return "AAC";
    }
  };

  return (
    <div className="ds-modal-overlay" onClick={handleCancel}>
      <div className="ds-modal mixtape-export-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="ds-modal-title">Export Mixtape</h2>

        {!exporting ? (
          <>
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
                <div className="mixtape-export-row">
                  <label>
                    Type
                    <select value={mixtapeType} onChange={(e) => setMixtapeType(e.target.value as MixtapeType)}>
                      <option value="custom">{mixtapeTypeLabel("custom")}</option>
                      <option value="album">{mixtapeTypeLabel("album")}</option>
                      <option value="best_of_artist">{mixtapeTypeLabel("best_of_artist")}</option>
                    </select>
                  </label>
                  <label>
                    Quality
                    <select value={quality} onChange={(e) => handleQualityChange(e.target.value as Quality)}>
                      <option value="flac">{qualityLabel("flac")}</option>
                      <option value="mp3_320">{qualityLabel("mp3_320")}</option>
                      <option value="mp3_128">{qualityLabel("mp3_128")}</option>
                      <option value="aac">{qualityLabel("aac")}</option>
                    </select>
                  </label>
                </div>
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
                          readOnly={entry.key === "quality"}
                          className={isDuplicate ? "mixtape-metadata-error" : ""}
                        />
                        <input
                          type="text"
                          value={entry.value}
                          onChange={(e) => handleMetadataValueChange(idx, e.target.value)}
                          placeholder="Value"
                          readOnly={entry.key === "quality"}
                        />
                        {entry.key !== "quality" && (
                          <button className="mixtape-metadata-remove" onClick={() => handleRemoveMetadata(idx)}>x</button>
                        )}
                      </div>
                    );
                  })}
                  <button className="mixtape-metadata-add" onClick={handleAddMetadata}>+ Add field</button>
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

            <div className="mixtape-export-tracklist">
              <div className="mixtape-export-tracklist-header">
                <span>{trackList.length} tracks</span>
                {estimatedSize > 0 && <span>~{formatFileSize(estimatedSize)}</span>}
              </div>
              {trackList.map((track, idx) => (
                <div
                  key={track.id}
                  className="mixtape-export-track"
                  draggable
                  onDragStart={() => handleDragStart(idx)}
                  onDragOver={(e) => handleDragOver(e, idx)}
                  onDragEnd={handleDragEnd}
                >
                  <span className="mixtape-track-grip">{"\u2807"}</span>
                  <span className="mixtape-track-num">{idx + 1}</span>
                  <div className="mixtape-track-info">
                    <span className="mixtape-track-title">{track.title}</span>
                    <span className="mixtape-track-artist">
                      {track.artistName}{track.albumTitle ? ` \u00B7 ${track.albumTitle}` : ""}
                    </span>
                  </div>
                  <span className="mixtape-track-duration">{formatDuration(track.durationSecs)}</span>
                </div>
              ))}
            </div>

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
                    ? `${(progress.current_track / progress.total_tracks) * 100}%`
                    : "0%",
                }}
              />
            </div>
            <div className="mixtape-progress-text">
              {progress
                ? `Exporting track ${progress.current_track} of ${progress.total_tracks}...`
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
