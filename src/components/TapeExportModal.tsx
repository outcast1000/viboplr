import { invoke } from "@tauri-apps/api/core";
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

interface TapeExportModalProps {
  tracks: ExportTrack[];
  defaultTitle?: string;
  onClose: () => void;
}

type TapeType = "custom" | "album" | "best_of_artist";
type Quality = "flac" | "mp3_320" | "mp3_128" | "aac";

interface TapeExportProgress {
  current_track: number;
  total_tracks: number;
  bytes_written: number;
}

const formatDuration = (secs?: number): string => {
  if (!secs) return "—";
  const mins = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${mins}:${s.toString().padStart(2, "0")}`;
};

const formatFileSize = (bytes?: number): string => {
  if (!bytes) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
};

export function TapeExportModal({ tracks, defaultTitle, onClose }: TapeExportModalProps) {
  const [title, setTitle] = useState(defaultTitle || "");
  const [comment, setComment] = useState("");
  const [tapeType, setTapeType] = useState<TapeType>("custom");
  const [quality, setQuality] = useState<Quality>("flac");
  const [coverPath, setCoverPath] = useState<string | null>(null);
  const [includeThumb, setIncludeThumb] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<TapeExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trackList, setTrackList] = useState<ExportTrack[]>(tracks);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

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

  const handleExport = useCallback(async () => {
    if (!title.trim()) {
      setError("Please enter a title");
      return;
    }

    const destPath = await save({
      filters: [{ name: "Tape", extensions: ["tape"] }],
      defaultPath: `${title}.tape`,
    });

    if (!destPath) return;

    setExporting(true);
    setProgress(null);
    setError(null);

    try {
      const options = {
        title: title.trim(),
        tapeType,
        quality,
        comment: comment.trim() || null,
        createdBy: null,
        coverImagePath: coverPath,
        includeThumbs: includeThumb,
        trackIds: trackList.map((t) => t.id),
      };

      await invoke("export_tape", { destPath, options });
    } catch (err) {
      setError(`Export failed: ${err}`);
      setExporting(false);
    }
  }, [title, comment, tapeType, quality, coverPath, includeThumb, trackList]);

  const handleCancel = useCallback(() => {
    if (exporting) {
      invoke("cancel_tape_export").catch(() => {});
    }
    onClose();
  }, [exporting, onClose]);

  useEffect(() => {
    const unlistenProgress = listen<TapeExportProgress>("tape-export-progress", (event) => {
      setProgress(event.payload);
    });

    const unlistenComplete = listen("tape-export-complete", () => {
      setExporting(false);
      onClose();
    });

    const unlistenError = listen<string>("tape-export-error", (event) => {
      setError(event.payload);
      setExporting(false);
    });

    return () => {
      unlistenProgress.then((fn) => fn());
      unlistenComplete.then((fn) => fn());
      unlistenError.then((fn) => fn());
    };
  }, [onClose]);

  const tapeTypeLabel = (type: TapeType): string => {
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
      <div className="ds-modal tape-export-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="ds-modal-title">Export Tape</h2>

        {!exporting ? (
          <>
            <div className="tape-export-form">
              <div className="tape-export-cover-section">
                {coverPath ? (
                  <img className="tape-export-cover-preview" src={`asset://localhost/${coverPath}`} alt="Cover" />
                ) : (
                  <div className="tape-export-cover-placeholder" onClick={handleCoverChoose}>No cover</div>
                )}
                <div className="tape-export-cover-actions">
                  <button onClick={handleCoverChoose}>Choose</button>
                  <button onClick={handleCoverPaste}>Paste</button>
                  {coverPath && <button onClick={handleCoverRemove}>Remove</button>}
                </div>
              </div>

              <div className="tape-export-fields">
                <label>
                  Title
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Tape title"
                    autoFocus
                  />
                </label>
                <div className="tape-export-row">
                  <label>
                    Type
                    <select value={tapeType} onChange={(e) => setTapeType(e.target.value as TapeType)}>
                      <option value="custom">{tapeTypeLabel("custom")}</option>
                      <option value="album">{tapeTypeLabel("album")}</option>
                      <option value="best_of_artist">{tapeTypeLabel("best_of_artist")}</option>
                    </select>
                  </label>
                  <label>
                    Quality
                    <select value={quality} onChange={(e) => setQuality(e.target.value as Quality)}>
                      <option value="flac">{qualityLabel("flac")}</option>
                      <option value="mp3_320">{qualityLabel("mp3_320")}</option>
                      <option value="mp3_128">{qualityLabel("mp3_128")}</option>
                      <option value="aac">{qualityLabel("aac")}</option>
                    </select>
                  </label>
                </div>
                <label>
                  Liner Notes
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="Write something for the recipient..."
                    rows={2}
                  />
                </label>
                <label className="tape-export-checkbox">
                  <input
                    type="checkbox"
                    checked={includeThumb}
                    onChange={(e) => setIncludeThumb(e.target.checked)}
                  />
                  Include track thumbnails
                </label>
              </div>
            </div>

            <div className="tape-export-tracklist">
              <div className="tape-export-tracklist-header">
                <span>{trackList.length} tracks</span>
                {estimatedSize > 0 && <span>~{formatFileSize(estimatedSize)}</span>}
              </div>
              {trackList.map((track, idx) => (
                <div
                  key={track.id}
                  className="tape-export-track"
                  draggable
                  onDragStart={() => handleDragStart(idx)}
                  onDragOver={(e) => handleDragOver(e, idx)}
                  onDragEnd={handleDragEnd}
                >
                  <span className="tape-track-grip">⠿</span>
                  <span className="tape-track-num">{idx + 1}</span>
                  <div className="tape-track-info">
                    <span className="tape-track-title">{track.title}</span>
                    <span className="tape-track-artist">
                      {track.artistName}{track.albumTitle ? ` · ${track.albumTitle}` : ""}
                    </span>
                  </div>
                  <span className="tape-track-duration">{formatDuration(track.durationSecs)}</span>
                </div>
              ))}
            </div>

            {error && <p className="tape-preview-error">{error}</p>}

            <div className="tape-preview-actions">
              <button className="tape-action-btn primary" onClick={handleExport} disabled={!title.trim()}>
                Export Tape
              </button>
              <button className="tape-action-btn cancel" onClick={handleCancel}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div className="tape-progress">
            <div className="tape-progress-bar">
              <div
                className="tape-progress-fill"
                style={{
                  width: progress
                    ? `${(progress.current_track / progress.total_tracks) * 100}%`
                    : "0%",
                }}
              />
            </div>
            <div className="tape-progress-text">
              {progress
                ? `Exporting track ${progress.current_track} of ${progress.total_tracks}...`
                : "Starting export..."}
            </div>
            <button className="tape-cancel-btn" onClick={handleCancel}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
