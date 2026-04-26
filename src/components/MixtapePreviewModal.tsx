import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { useState, useEffect, useCallback } from "react";
import type { MixtapePreview, MixtapeImportProgress, Track } from "../types";
import playlistDefault from "../assets/playlist-default.png";

interface MixtapePreviewModalProps {
  mixtapePath: string;
  onClose: () => void;
  onQueueTracks?: (tracks: Track[], context: { name: string; imagePath?: string | null }) => void;
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
    const unlistenProgress = listen<MixtapeImportProgress>(
      "mixtape-import-progress",
      (event) => {
        setProgress(event.payload);
      }
    );

    const unlistenComplete = listen("mixtape-import-complete", () => {
      setImporting(false);
      setProgress(null);
      onClose();
    });

    const unlistenError = listen<string>("mixtape-import-error", (event) => {
      setError(event.payload);
      setImporting(false);
      setProgress(null);
    });

    const unlistenJustPlay = listen<Track[]>("mixtape-just-play", (event) => {
      if (onQueueTracks && preview) {
        onQueueTracks(event.payload, {
          name: preview.manifest.title,
          imagePath: preview.cover_temp_path,
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
            title: "Select destination folder for mixtape files",
          });
          if (!targetFolder) {
            return; // User cancelled
          }
        }

        setImporting(true);
        setProgress(null);

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

  const formatDuration = (secs: number | undefined) => {
    if (!secs) return "\u2014";
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
                  onClick={() => handleImport("playlist_and_files")}
                >
                  Import Playlist + Files
                </button>
                <button
                  className="mixtape-action-btn"
                  onClick={() => handleImport("playlist_only")}
                >
                  Import Playlist Only
                </button>
                <button
                  className="mixtape-action-btn"
                  onClick={() => handleImport("files_only")}
                >
                  Import Files Only
                </button>
                <button
                  className="mixtape-action-btn"
                  onClick={() => handleImport("just_play")}
                >
                  Just Play
                </button>
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
