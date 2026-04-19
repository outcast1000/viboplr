import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { useState, useEffect, useCallback } from "react";
import type { TapePreview, TapeImportProgress, Track } from "../types";
import playlistDefault from "../assets/playlist-default.png";

interface TapePreviewModalProps {
  tapePath: string;
  onClose: () => void;
  onQueueTracks?: (tracks: Track[], context: { name: string; coverPath?: string | null }) => void;
}

const TYPE_LABELS: Record<string, string> = {
  custom: "Mixtape",
  album: "Album",
  best_of_artist: "Best Of",
};

export function TapePreviewModal({
  tapePath,
  onClose,
  onQueueTracks,
}: TapePreviewModalProps) {
  const [preview, setPreview] = useState<TapePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<TapeImportProgress | null>(null);

  // Load tape preview on mount
  useEffect(() => {
    let mounted = true;

    const loadPreview = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await invoke<TapePreview>("preview_tape", {
          path: tapePath,
        });
        if (mounted) {
          setPreview(data);
          setLoading(false);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    };

    loadPreview();

    return () => {
      mounted = false;
    };
  }, [tapePath]);

  // Listen for import progress events
  useEffect(() => {
    const unlistenProgress = listen<TapeImportProgress>(
      "tape-import-progress",
      (event) => {
        setProgress(event.payload);
      }
    );

    const unlistenComplete = listen("tape-import-complete", () => {
      setImporting(false);
      setProgress(null);
      onClose();
    });

    const unlistenError = listen<string>("tape-import-error", (event) => {
      setError(event.payload);
      setImporting(false);
      setProgress(null);
    });

    const unlistenJustPlay = listen<Track[]>("tape-just-play", (event) => {
      if (onQueueTracks && preview) {
        onQueueTracks(event.payload, {
          name: preview.manifest.title,
          coverPath: preview.cover_temp_path,
        });
      }
      onClose();
    });

    return () => {
      unlistenProgress.then((fn) => fn());
      unlistenComplete.then((fn) => fn());
      unlistenError.then((fn) => fn());
      unlistenJustPlay.then((fn) => fn());
    };
  }, [onClose, onQueueTracks, preview]);

  const handleImport = useCallback(
    async (mode: "playlist_and_files" | "playlist_only" | "files_only" | "just_play") => {
      try {
        setError(null);

        // If "files_only", open folder picker
        let targetFolder: string | null = null;
        if (mode === "files_only") {
          targetFolder = await open({
            directory: true,
            title: "Select destination folder for tape files",
          });
          if (!targetFolder) {
            return; // User cancelled
          }
        }

        setImporting(true);
        setProgress(null);

        await invoke("import_tape", {
          path: tapePath,
          mode,
          targetFolder,
        });

        // For non-blocking modes, the complete event will close the modal
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setImporting(false);
        setProgress(null);
      }
    },
    [tapePath]
  );

  const handleCancel = useCallback(async () => {
    try {
      await invoke("cancel_tape_operation");
      setImporting(false);
      setProgress(null);
    } catch (err) {
      console.error("Failed to cancel tape operation:", err);
    }
  }, []);

  const formatDuration = (secs: number | undefined) => {
    if (!secs) return "—";
    const mins = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${mins}:${s.toString().padStart(2, "0")}`;
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024)
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const formatTotalDuration = (secs: number) => {
    const hours = Math.floor(secs / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${mins}m`;
    }
    return `${mins}m`;
  };

  return (
    <div className="ds-modal-overlay" onClick={onClose}>
      <div className="ds-modal tape-preview-modal" onClick={(e) => e.stopPropagation()}>
        {loading && (
          <div className="tape-preview-loading">
            <div>Loading tape preview...</div>
          </div>
        )}

        {error && !loading && (
          <div className="tape-preview-error">
            <div>Failed to load tape</div>
            <div>{error}</div>
            <button className="tape-action-btn" onClick={onClose}>
              Close
            </button>
          </div>
        )}

        {preview && !loading && (
          <>
            <div className="tape-preview-header">
              <img
                src={preview.cover_temp_path ? convertFileSrc(preview.cover_temp_path) : playlistDefault}
                alt="Tape cover"
                className="tape-preview-cover"
              />
              <div className="tape-preview-info">
                <h2>{preview.manifest.title}</h2>
                <div className="tape-preview-badges">
                  <span className="tape-badge">
                    {TYPE_LABELS[preview.manifest.type] || preview.manifest.type}
                  </span>
                  <span className="tape-badge">{preview.manifest.quality}</span>
                </div>
                {preview.manifest.comment && (
                  <div className="tape-preview-comment">{preview.manifest.comment}</div>
                )}
                <div className="tape-preview-meta">
                  {preview.manifest.created_by && (
                    <div>Created by: {preview.manifest.created_by}</div>
                  )}
                  <div>
                    {preview.manifest.tracks.length} tracks •{" "}
                    {formatTotalDuration(preview.total_duration_secs)} •{" "}
                    {formatFileSize(preview.file_size)}
                  </div>
                </div>
              </div>
            </div>

            <div className="tape-preview-tracklist">
              {preview.manifest.tracks.map((track, index) => (
                <div key={index} className="tape-preview-track">
                  <span className="tape-track-num">{index + 1}</span>
                  <div className="tape-track-info">
                    <div className="tape-track-title">{track.title}</div>
                    <div className="tape-track-artist">
                      {track.artist}
                      {track.album && ` • ${track.album}`}
                    </div>
                  </div>
                  <span className="tape-track-duration">
                    {formatDuration(track.duration_secs ?? undefined)}
                  </span>
                </div>
              ))}
            </div>

            {importing && progress && (
              <div className="tape-progress">
                <div className="tape-progress-bar">
                  <div
                    className="tape-progress-fill"
                    style={{
                      width: `${(progress.current_track / progress.total_tracks) * 100}%`,
                    }}
                  />
                </div>
                <div className="tape-progress-text">
                  Importing {progress.current_track} / {progress.total_tracks}: {progress.track_title}
                </div>
                <button className="tape-cancel-btn" onClick={handleCancel}>
                  Cancel
                </button>
              </div>
            )}

            {!importing && (
              <div className="tape-preview-actions">
                <button
                  className="tape-action-btn primary"
                  onClick={() => handleImport("playlist_and_files")}
                >
                  Import Playlist + Files
                </button>
                <button
                  className="tape-action-btn"
                  onClick={() => handleImport("playlist_only")}
                >
                  Import Playlist Only
                </button>
                <button
                  className="tape-action-btn"
                  onClick={() => handleImport("files_only")}
                >
                  Import Files Only
                </button>
                <button
                  className="tape-action-btn"
                  onClick={() => handleImport("just_play")}
                >
                  Just Play
                </button>
                <button className="tape-action-btn cancel" onClick={onClose}>
                  Cancel
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
