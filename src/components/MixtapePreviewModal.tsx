import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { track as trackTelemetry } from "../telemetry";
import { open } from "@tauri-apps/plugin-dialog";
import { subscribe, combineUnlisten } from "../utils/tauriEvents";
import { useState, useEffect, useCallback } from "react";
import type { MixtapePreview, MixtapeImportProgress, Track } from "../types";
import { formatDuration, formatFileSize } from "../utils";
import playlistDefault from "../assets/playlist-default.png";
import "./Mixtape.css";

interface MixtapePreviewModalProps {
  mixtapePath: string;
  onClose: () => void;
  onQueueTracks?: (tracks: Track[], context: { name: string; imagePath?: string | null; metadata?: Record<string, string> | null }) => void;
}

const TYPE_LABELS: Record<string, string> = {
  custom: "Mixtape",
  album: "Album",
  best_of_artist: "Best Of",
};

export function MixtapePreviewModal({
  mixtapePath,
  onClose,
  onQueueTracks,
}: MixtapePreviewModalProps) {
  const [preview, setPreview] = useState<MixtapePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<MixtapeImportProgress | null>(null);
  const [showImportOptions, setShowImportOptions] = useState(false);

  // Load mixtape preview on mount
  useEffect(() => {
    let mounted = true;

    const loadPreview = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await invoke<MixtapePreview>("preview_mixtape", {
          path: mixtapePath,
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
  }, [mixtapePath]);

  // Listen for import progress events
  useEffect(() => {
    const stopProgress = subscribe<MixtapeImportProgress>(
      "mixtape-import-progress",
      (event) => {
        setProgress(event.payload);
      }
    );

    const stopComplete = subscribe("mixtape-import-complete", () => {
      setImporting(false);
      setProgress(null);
      onClose();
    });

    const stopError = subscribe<string>("mixtape-import-error", (event) => {
      setError(event.payload);
      setImporting(false);
      setProgress(null);
    });

    const stopJustPlay = subscribe<{ tracks: Track[]; coverPath?: string }>("mixtape-just-play", (event) => {
      if (onQueueTracks && preview) {
        const meta = preview.manifest.metadata && Object.keys(preview.manifest.metadata).length > 0
          ? preview.manifest.metadata as Record<string, string>
          : null;
        onQueueTracks(event.payload.tracks, {
          name: preview.manifest.title,
          imagePath: event.payload.coverPath || preview.cover_temp_path,
          metadata: meta,
        });
      }
      onClose();
    });

    return combineUnlisten(stopProgress, stopComplete, stopError, stopJustPlay);
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
            title: "Select destination folder for mixtape files",
          });
          if (!targetFolder) {
            return; // User cancelled
          }
        }

        setImporting(true);
        setProgress(null);

        trackTelemetry("playlist_loaded", { format: "mixtape", mode });
        await invoke("import_mixtape", {
          path: mixtapePath,
          mode,
          destDir: targetFolder,
        });

        // For non-blocking modes, the complete event will close the modal
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setImporting(false);
        setProgress(null);
      }
    },
    [mixtapePath]
  );

  const handleCancel = useCallback(async () => {
    try {
      await invoke("cancel_mixtape_operation");
      setImporting(false);
      setProgress(null);
    } catch (err) {
      console.error("Failed to cancel mixtape operation:", err);
    }
  }, []);


  const formatTotalDuration = (secs: number) => {
    const hours = Math.floor(secs / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${mins}m`;
    }
    return `${mins}m`;
  };

  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal mixtape-preview-modal" onClick={(e) => e.stopPropagation()}>
        {loading && (
          <div className="mixtape-preview-loading">
            <div>Loading mixtape preview...</div>
          </div>
        )}

        {error && !loading && (
          <div className="mixtape-preview-error">
            <div>Failed to load mixtape</div>
            <div>{error}</div>
            <button className="mixtape-action-btn" onClick={onClose}>
              Close
            </button>
          </div>
        )}

        {preview && !loading && (
          <>
            <div className="mixtape-preview-header">
              <img
                src={preview.cover_temp_path ? convertFileSrc(preview.cover_temp_path) : playlistDefault}
                alt="Mixtape cover"
                className="mixtape-preview-cover"
              />
              <div className="mixtape-preview-info">
                <h2>{preview.manifest.title}</h2>
                <div className="mixtape-preview-badges">
                  <span className="mixtape-badge">
                    {TYPE_LABELS[preview.manifest.type] || preview.manifest.type}
                  </span>
                  {preview.manifest.metadata?.quality && (
                    <span className="mixtape-badge">{preview.manifest.metadata.quality}</span>
                  )}
                </div>
                {preview.manifest.metadata && Object.keys(preview.manifest.metadata).filter(k => k !== "quality").length > 0 && (
                  <div className="mixtape-preview-metadata">
                    {Object.entries(preview.manifest.metadata)
                      .filter(([key]) => key !== "quality")
                      .map(([key, value]) => {
                        const displayKey = key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
                        if (key === "liner_notes") {
                          return <div key={key} className="mixtape-preview-comment">{value}</div>;
                        }
                        return (
                          <div key={key} className="mixtape-preview-meta-entry">
                            <span className="mixtape-meta-key">{displayKey}:</span> {value}
                          </div>
                        );
                      })}
                  </div>
                )}
                <div className="mixtape-preview-meta">
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

            <div className="mixtape-preview-tracklist">
              {preview.manifest.tracks.map((track, index) => (
                <div key={index} className="mixtape-preview-track">
                  <span className="mixtape-track-num">{index + 1}</span>
                  <div className="mixtape-track-info">
                    <div className="mixtape-track-title">{track.title}</div>
                    <div className="mixtape-track-artist">
                      {track.artist}
                      {track.album && ` \u2022 ${track.album}`}
                    </div>
                  </div>
                  <span className="mixtape-track-duration">
                    {formatDuration(track.duration_secs ?? undefined)}
                  </span>
                </div>
              ))}
            </div>

            {importing && progress && (
              <div className="mixtape-progress">
                <div className="mixtape-progress-bar">
                  <div
                    className="mixtape-progress-fill"
                    style={{
                      width: `${(progress.current_track / progress.total_tracks) * 100}%`,
                    }}
                  />
                </div>
                <div className="mixtape-progress-text">
                  Importing {progress.current_track} / {progress.total_tracks}: {progress.track_title}
                </div>
                <button className="mixtape-cancel-btn" onClick={handleCancel}>
                  Cancel
                </button>
              </div>
            )}

            {!importing && (
              <div className="mixtape-preview-actions">
                <button
                  className="mixtape-action-btn primary"
                  onClick={() => handleImport("just_play")}
                >
                  ▶ Play
                </button>
                <div className="mixtape-import-disclosure">
                  <button
                    className="mixtape-disclosure-toggle"
                    onClick={() => setShowImportOptions(!showImportOptions)}
                  >
                    <span className={`mixtape-disclosure-arrow${showImportOptions ? " open" : ""}`}>▸</span>
                    Import options
                  </button>
                  {showImportOptions && (
                    <div className="mixtape-import-options">
                      <button
                        className="mixtape-action-btn secondary"
                        onClick={() => handleImport("playlist_and_files")}
                      >
                        Import Playlist + Files
                      </button>
                      <button
                        className="mixtape-action-btn secondary"
                        onClick={() => handleImport("playlist_only")}
                      >
                        Import Playlist Only
                      </button>
                      <button
                        className="mixtape-action-btn secondary"
                        onClick={() => handleImport("files_only")}
                      >
                        Extract Files Only
                      </button>
                    </div>
                  )}
                </div>
                <button className="mixtape-action-btn cancel" onClick={onClose}>
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
