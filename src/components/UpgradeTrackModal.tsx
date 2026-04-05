import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Track, TidalSearchTrack } from "../types";
import { formatDuration, tidalCoverUrl } from "../utils";
import "./UpgradeTrackModal.css";

interface UpgradePreviewInfo {
  old_path: string;
  old_format: string | null;
  old_file_size: number | null;
  new_path: string;
  new_format: string | null;
  new_file_size: number | null;
}

interface UpgradeTrackModalProps {
  track: Track;
  downloadFormat: string;
  onClose: () => void;
  onUpgraded: (message: string) => void;
}

type Step = "search" | "downloading" | "compare";

function formatFileSize(bytes: number | null): string {
  if (!bytes) return "\u2014";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpgradeTrackModal({ track, downloadFormat, onClose, onUpgraded }: UpgradeTrackModalProps) {
  const [step, setStep] = useState<Step>("search");
  const [results, setResults] = useState<TidalSearchTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<UpgradePreviewInfo | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);

  // Listen to download progress events during the downloading step
  useEffect(() => {
    if (step !== "downloading") return;
    setDownloadProgress(0);
    const unlisten = listen<number>("upgrade-download-progress", (event) => {
      setDownloadProgress(event.payload);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [step]);

  // Auto-search on mount
  useEffect(() => {
    const query = [track.title, track.artist_name].filter(Boolean).join(" ");
    if (!query) {
      setError("Track has no title or artist to search for");
      setLoading(false);
      return;
    }
    invoke<{ tracks: TidalSearchTrack[] }>("tidal_search", {
      query,
      limit: 10,
      offset: 0,
    })
      .then((res) => setResults(res.tracks))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [track]);

  async function handleSelectMatch(tidalTrack: TidalSearchTrack) {
    setStep("downloading");
    setError(null);
    try {
      const info = await invoke<UpgradePreviewInfo>("tidal_download_preview", {
        trackId: track.id,
        tidalTrackId: tidalTrack.tidal_id,
        format: downloadFormat,
      });
      setPreview(info);
      setStep("compare");
    } catch (e) {
      setError(String(e));
      setStep("search");
    }
  }

  async function handleConfirm() {
    if (!preview) return;
    setConfirming(true);
    try {
      await invoke("confirm_track_upgrade", {
        trackId: track.id,
        newPath: preview.new_path,
      });
      onUpgraded("Track replaced with TIDAL version");
    } catch (e) {
      setError(String(e));
      setConfirming(false);
    }
  }

  async function handleSaveAsCopy() {
    if (!preview) return;
    setConfirming(true);
    try {
      await invoke("save_track_as_copy", {
        trackId: track.id,
        newPath: preview.new_path,
      });
      onUpgraded("TIDAL copy saved alongside original");
    } catch (e) {
      setError(String(e));
      setConfirming(false);
    }
  }

  async function handleCancel() {
    if (preview) {
      await invoke("cancel_track_upgrade", { newPath: preview.new_path }).catch(() => {});
    }
    onClose();
  }

  async function handleBackToSearch() {
    if (preview) {
      await invoke("cancel_track_upgrade", { newPath: preview.new_path }).catch(() => {});
      setPreview(null);
    }
    setStep("search");
  }

  return (
    <div className="modal-overlay" onClick={handleCancel}>
      <div className="modal upgrade-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Upgrade via TIDAL</h2>
        <p className="upgrade-modal-track">
          {track.title}{track.artist_name ? ` \u2014 ${track.artist_name}` : ""}
        </p>

        {error && <div className="upgrade-modal-error">{error}</div>}

        {step === "search" && (
          <>
            <h3>Select TIDAL match</h3>
            {loading ? (
              <div className="upgrade-modal-loading">Searching TIDAL...</div>
            ) : results.length === 0 ? (
              <div className="upgrade-modal-empty">No matches found on TIDAL</div>
            ) : (
              <div className="upgrade-modal-results">
                {results.map((t) => (
                  <div
                    key={t.tidal_id}
                    className="upgrade-modal-result"
                    onClick={() => handleSelectMatch(t)}
                  >
                    <div className="upgrade-modal-result-art">
                      {tidalCoverUrl(t.cover_id, 80) ? (
                        <img src={tidalCoverUrl(t.cover_id, 80)!} alt="" />
                      ) : (
                        <div className="tidal-art-placeholder" />
                      )}
                    </div>
                    <div className="upgrade-modal-result-info">
                      <span className="upgrade-modal-result-title">{t.title}</span>
                      <span className="upgrade-modal-result-meta">
                        {t.artist_name}{t.album_title ? ` \u2014 ${t.album_title}` : ""}
                      </span>
                    </div>
                    <span className="upgrade-modal-result-duration">
                      {formatDuration(t.duration_secs)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="upgrade-modal-actions">
              <button onClick={handleCancel}>Cancel</button>
            </div>
          </>
        )}

        {step === "downloading" && (
          <div className="upgrade-modal-downloading">
            <div className="upgrade-modal-loading">Downloading from TIDAL...</div>
            <div className="upgrade-modal-progress">
              <div className="upgrade-modal-progress-bar">
                <div className="upgrade-modal-progress-fill" style={{ width: `${downloadProgress}%` }} />
              </div>
              <span className="upgrade-modal-progress-pct">{downloadProgress}%</span>
            </div>
          </div>
        )}

        {step === "compare" && preview && (
          <>
            <h3>Compare files</h3>
            <div className="upgrade-modal-compare">
              <div className="upgrade-modal-compare-col">
                <h4>Current file</h4>
                <div className="upgrade-modal-field">
                  <span>Format</span>
                  <span>{preview.old_format?.toUpperCase() ?? "\u2014"}</span>
                </div>
                <div className="upgrade-modal-field">
                  <span>Size</span>
                  <span>{formatFileSize(preview.old_file_size)}</span>
                </div>
              </div>
              <div className="upgrade-modal-compare-arrow">{"\u2192"}</div>
              <div className="upgrade-modal-compare-col">
                <h4>TIDAL version</h4>
                <div className="upgrade-modal-field">
                  <span>Format</span>
                  <span>{preview.new_format?.toUpperCase() ?? "\u2014"}</span>
                </div>
                <div className="upgrade-modal-field">
                  <span>Size</span>
                  <span>{formatFileSize(preview.new_file_size)}</span>
                </div>
              </div>
            </div>
            <div className="upgrade-modal-actions">
              <button onClick={handleBackToSearch}>Back</button>
              <button className="upgrade-modal-btn-replace" onClick={handleConfirm} disabled={confirming}>
                {confirming ? "Replacing..." : "Replace"}
              </button>
              <button className="upgrade-modal-btn-copy" onClick={handleSaveAsCopy} disabled={confirming}>
                {confirming ? "Saving..." : "Save as Copy"}
              </button>
              <button onClick={handleCancel}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
