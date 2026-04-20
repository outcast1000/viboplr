import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { TidalSearchTrack, Track } from "../types";
import { formatDuration, tidalCoverUrl } from "../utils";
import type { AppStore } from "../store";
import "./TidalDownloadModal.css";

interface TidalDownloadModalProps {
  input: {
    trackId: number | null;
    title: string;
    artistName: string | null;
  };
  libraryTrack: Track | null;
  downloadFormat: string;
  collections: { id: number; name: string; path: string }[];
  store: AppStore;
  lastDest: string | null;
  onSearch: (query: string, limit: number) => void;
  searchResults: TidalSearchTrack[] | null;
  searchError: string | null;
  resolveStreamUrl: (trackId: string, quality?: string | null) => Promise<string>;
  onClose: () => void;
  onComplete: (message: string) => void;
}

interface UpgradePreviewInfo {
  old_path: string;
  old_format: string | null;
  old_file_size: number | null;
  new_path: string;
  new_format: string | null;
  new_file_size: number | null;
}

interface ConflictCheck {
  has_conflict: boolean;
  dest_path: string;
  existing_size: number | null;
  existing_format: string | null;
}

interface DownloadResult {
  path: string;
  format: string;
  file_size: number;
}

type Step = "search" | "configure" | "conflict" | "downloading" | "result";

function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes) return "\u2014";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function TidalDownloadModal({
  input,
  libraryTrack,
  downloadFormat,
  collections,
  store,
  lastDest,
  onSearch,
  searchResults,
  searchError,
  resolveStreamUrl,
  onClose,
  onComplete,
}: TidalDownloadModalProps) {
  const [step, setStep] = useState<Step>("search");
  const [searchQuery, setSearchQuery] = useState(
    [input.title, input.artistName].filter(Boolean).join(" ")
  );
  const [results, setResults] = useState<TidalSearchTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Configure state
  const [selectedMatch, setSelectedMatch] = useState<TidalSearchTrack | null>(null);
  const [quality, setQuality] = useState<"flac" | "aac">(
    downloadFormat === "flac" ? "flac" : "aac"
  );
  const isUpgrade = !!libraryTrack && input.trackId !== null;
  const [showDestPicker, setShowDestPicker] = useState(!isUpgrade);
  const [destType, setDestType] = useState<"collection" | "path">("collection");
  const [destCollectionId, setDestCollectionId] = useState<number | null>(() => {
    if (lastDest) {
      const parsed = parseInt(lastDest, 10);
      if (!isNaN(parsed) && collections.some(c => c.id === parsed)) return parsed;
    }
    return collections.length > 0 ? collections[0].id : null;
  });
  const [destPath, setDestPath] = useState<string | null>(null);

  // Conflict state
  const [conflict, setConflict] = useState<ConflictCheck | null>(null);
  const [resolvedStreamUrl, setResolvedStreamUrl] = useState<string | null>(null);
  const [resolvedCoverUrl, setResolvedCoverUrl] = useState<string | undefined>(undefined);

  // Download state
  const [downloadProgress, setDownloadProgress] = useState(0);

  // Result state
  const [upgradePreview, setUpgradePreview] = useState<UpgradePreviewInfo | null>(null);
  const [downloadResult, setDownloadResult] = useState<DownloadResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [addedToLibrary, setAddedToLibrary] = useState(false);

  // Auto-search on mount
  useEffect(() => {
    if (!searchQuery) {
      setError("No title or artist to search for");
      setLoading(false);
      return;
    }
    doSearch(searchQuery);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (searchResults !== null) {
      setResults(searchResults);
      setLoading(false);
    }
  }, [searchResults]);

  useEffect(() => {
    if (searchError !== null) {
      setError(searchError);
      setLoading(false);
    }
  }, [searchError]);

  function doSearch(query: string) {
    setLoading(true);
    setError(null);
    setResults([]);
    onSearch(query, 10);
  }

  function handleSelectMatch(match: TidalSearchTrack) {
    setSelectedMatch(match);
    setStep("configure");
    setError(null);
  }

  async function handleStartDownload() {
    if (!selectedMatch) return;
    setError(null);

    // Resolve stream URL and metadata from the plugin
    const tidalQuality = quality === "flac" ? "LOSSLESS" : "HIGH";
    let streamUrl: string;
    try {
      streamUrl = await resolveStreamUrl(selectedMatch.tidal_id, tidalQuality);
    } catch (e) {
      setError(`Failed to resolve stream URL: ${String(e)}`);
      return;
    }

    const coverUrl = tidalCoverUrl(selectedMatch.cover_id, 1280) ?? undefined;
    setResolvedStreamUrl(streamUrl);
    setResolvedCoverUrl(coverUrl);

    if (isUpgrade && !showDestPicker) {
      // Upgrade path: download preview next to original file
      setStep("downloading");
      try {
        const info = await invoke<UpgradePreviewInfo>("download_preview", {
          trackId: input.trackId,
          streamUrl,
          format: quality,
          title: selectedMatch.title,
          artistName: selectedMatch.artist_name ?? null,
          albumTitle: selectedMatch.album_title ?? null,
          trackNumber: selectedMatch.track_number ?? null,
          coverUrl: coverUrl ?? null,
        });
        setUpgradePreview(info);
        setStep("result");
      } catch (e) {
        setError(String(e));
        setStep("configure");
      }
      return;
    }

    // Fresh download path: check for conflicts first
    const destDir = resolveDestDir();
    if (!destDir) {
      setError("Please select a destination");
      return;
    }

    try {
      const check = await invoke<ConflictCheck>("check_dest_conflict", {
        artistName: selectedMatch.artist_name ?? "Unknown",
        trackTitle: selectedMatch.title,
        destDir,
        format: quality,
      });

      if (check.has_conflict) {
        setConflict(check);
        setStep("conflict");
      } else {
        await doFreshDownload(check.dest_path, false, streamUrl, coverUrl);
      }
    } catch {
      // Treat conflict check errors as no conflict
      const ext = quality === "flac" ? "flac" : "m4a";
      const fallbackPath = `${destDir}/${selectedMatch.artist_name ?? "Unknown"} - ${selectedMatch.title}.${ext}`;
      await doFreshDownload(fallbackPath, false, streamUrl, coverUrl);
    }
  }

  async function doFreshDownload(dp: string, overwrite: boolean, streamUrlArg?: string, coverUrlArg?: string) {
    if (!selectedMatch) return;
    const url = streamUrlArg || resolvedStreamUrl;
    if (!url) {
      setError("No stream URL available");
      return;
    }
    setStep("downloading");
    setDownloadProgress(0);

    // Save last used destination
    const collId = destType === "collection" ? destCollectionId : null;
    store.set("lastTidalDownloadDest", collId != null ? String(collId) : null);

    const cover = coverUrlArg || resolvedCoverUrl;

    try {
      const result = await invoke<DownloadResult>("download_to_path", {
        streamUrl: url,
        destPath: dp,
        format: quality,
        overwrite,
        title: selectedMatch.title,
        artistName: selectedMatch.artist_name ?? null,
        albumTitle: selectedMatch.album_title ?? null,
        trackNumber: selectedMatch.track_number ?? null,
        coverUrl: cover ?? null,
      });
      setDownloadResult(result);

      // If downloaded to a collection, index it
      if (destType === "collection" && destCollectionId != null) {
        try {
          await invoke("add_downloaded_track", {
            path: result.path,
            collectionId: destCollectionId,
          });
          setAddedToLibrary(true);
        } catch {
          // Non-blocking — file is saved, just not indexed
        }
      }

      setStep("result");
    } catch (e) {
      setError(String(e));
      setStep("configure");
    }
  }

  function resolveDestDir(): string | null {
    if (destType === "collection" && destCollectionId != null) {
      const coll = collections.find(c => c.id === destCollectionId);
      return coll?.path ?? null;
    }
    return destPath;
  }

  async function handleBrowseFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      setDestType("path");
      setDestPath(selected);
      setDestCollectionId(null);
    }
  }

  function handleConflictReplace() {
    if (conflict) doFreshDownload(conflict.dest_path, true);
  }

  function handleConflictKeepBoth() {
    if (!conflict) return;
    const p = conflict.dest_path;
    const dotIdx = p.lastIndexOf(".");
    const base = dotIdx > 0 ? p.substring(0, dotIdx) : p;
    const ext = dotIdx > 0 ? p.substring(dotIdx) : "";
    const candidate = `${base} (2)${ext}`;
    doFreshDownload(candidate, false);
  }

  async function handleCancel() {
    if (step === "downloading") {
      await invoke("cancel_direct_download").catch(() => {});
    }
    if (upgradePreview) {
      await invoke("cancel_track_upgrade", { newPath: upgradePreview.new_path }).catch(() => {});
    }
    onClose();
  }

  async function handleReplace() {
    if (!upgradePreview) return;
    setConfirming(true);
    try {
      await invoke("confirm_track_upgrade", {
        trackId: input.trackId,
        newPath: upgradePreview.new_path,
      });
      onComplete("Track replaced with TIDAL version");
    } catch (e) {
      setError(String(e));
      setConfirming(false);
    }
  }

  async function handleSaveAsCopy() {
    if (!upgradePreview) return;
    setConfirming(true);
    try {
      await invoke("save_track_as_copy", {
        trackId: input.trackId,
        newPath: upgradePreview.new_path,
      });
      onComplete("TIDAL copy saved alongside original");
    } catch (e) {
      setError(String(e));
      setConfirming(false);
    }
  }

  async function handleBackToSearch() {
    if (upgradePreview) {
      await invoke("cancel_track_upgrade", { newPath: upgradePreview.new_path }).catch(() => {});
      setUpgradePreview(null);
    }
    setSelectedMatch(null);
    setStep("search");
  }

  // Listen to progress events
  useEffect(() => {
    if (step !== "downloading") return;
    setDownloadProgress(0);
    const eventName = isUpgrade && !showDestPicker
      ? "upgrade-download-progress"
      : "direct-download-progress";
    const unlisten = listen<number>(eventName, (event) => {
      setDownloadProgress(event.payload);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [step, isUpgrade, showDestPicker]);

  return (
    <div className="ds-modal-overlay" onClick={handleCancel}>
      <div className="ds-modal tidal-dl-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="ds-modal-title">{isUpgrade && !showDestPicker ? "Upgrade via TIDAL" : "Download from TIDAL"}</h2>
        <p className="tidal-dl-track">
          {input.title}{input.artistName ? ` \u2014 ${input.artistName}` : ""}
        </p>

        {error && <div className="tidal-dl-error">{error}</div>}

        {/* SEARCH STEP */}
        {step === "search" && (
          <>
            <div className="tidal-dl-search-field">
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") doSearch(searchQuery); }}
                placeholder="Search TIDAL..."
              />
              <button onClick={() => doSearch(searchQuery)}>Search</button>
            </div>
            {loading ? (
              <div className="tidal-dl-loading">Searching TIDAL...</div>
            ) : results.length === 0 ? (
              <div className="tidal-dl-empty">No matches found on TIDAL</div>
            ) : (
              <div className="tidal-dl-results">
                {results.map((t) => (
                  <div key={t.tidal_id} className="tidal-dl-result" onClick={() => handleSelectMatch(t)}>
                    <div className="tidal-dl-result-art">
                      {tidalCoverUrl(t.cover_id, 80) ? (
                        <img src={tidalCoverUrl(t.cover_id, 80)!} alt="" />
                      ) : (
                        <div className="tidal-art-placeholder" />
                      )}
                    </div>
                    <div className="tidal-dl-result-info">
                      <span className="tidal-dl-result-title">{t.title}</span>
                      <span className="tidal-dl-result-meta">
                        {t.artist_name}{t.album_title ? ` \u2014 ${t.album_title}` : ""}
                      </span>
                    </div>
                    <span className="tidal-dl-result-duration">
                      {t.duration_secs ? formatDuration(t.duration_secs) : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="tidal-dl-actions">
              <button onClick={handleCancel}>Cancel</button>
            </div>
          </>
        )}

        {/* CONFIGURE STEP */}
        {step === "configure" && selectedMatch && (
          <>
            <div className="tidal-dl-selected">
              {tidalCoverUrl(selectedMatch.cover_id, 80) && (
                <img src={tidalCoverUrl(selectedMatch.cover_id, 80)!} alt="" />
              )}
              <div className="tidal-dl-selected-info">
                <span className="tidal-dl-result-title">{selectedMatch.title}</span>
                <span className="tidal-dl-result-meta">
                  {selectedMatch.artist_name}{selectedMatch.album_title ? ` \u2014 ${selectedMatch.album_title}` : ""}
                </span>
              </div>
            </div>

            <div className="tidal-dl-config-row">
              <label>Quality</label>
              <select value={quality} onChange={(e) => setQuality(e.target.value as "flac" | "aac")}>
                <option value="flac">FLAC (Lossless)</option>
                <option value="aac">AAC (320kbps)</option>
              </select>
            </div>

            {isUpgrade && !showDestPicker && (
              <button className="tidal-dl-save-elsewhere" onClick={() => setShowDestPicker(true)}>
                Save elsewhere instead...
              </button>
            )}

            {showDestPicker && (
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
                    <option key={c.id} value={String(c.id)}>{c.name} — {c.path}</option>
                  ))}
                  <option value="__browse__">Browse to folder...</option>
                </select>
              </div>
            )}

            {destType === "path" && destPath && showDestPicker && (
              <div className="tidal-dl-config-row">
                <label />
                <span className="tidal-dl-dest-display">{destPath}</span>
              </div>
            )}

            <div className="tidal-dl-actions">
              <button onClick={handleBackToSearch}>Back</button>
              <button className="tidal-dl-btn-primary" onClick={handleStartDownload}>
                Download
              </button>
            </div>
          </>
        )}

        {/* CONFLICT STEP */}
        {step === "conflict" && conflict && (
          <>
            <div className="tidal-dl-conflict">
              <div className="tidal-dl-conflict-filename">
                &ldquo;{conflict.dest_path.split(/[\\/]/).pop()}&rdquo; already exists
              </div>
              <div className="tidal-dl-conflict-size">
                Existing file: {conflict.existing_format ?? "Unknown"}, {formatFileSize(conflict.existing_size)}
              </div>
            </div>
            <div className="tidal-dl-actions">
              <button onClick={() => { setConflict(null); setStep("configure"); }}>Cancel</button>
              <button className="tidal-dl-btn-secondary" onClick={handleConflictKeepBoth}>Keep Both</button>
              <button className="tidal-dl-btn-primary" onClick={handleConflictReplace}>Replace</button>
            </div>
          </>
        )}

        {/* DOWNLOADING STEP */}
        {step === "downloading" && (
          <div className="tidal-dl-downloading">
            <div className="tidal-dl-loading">Downloading from TIDAL...</div>
            <div className="tidal-dl-progress">
              <div className="tidal-dl-progress-bar">
                <div className="tidal-dl-progress-fill" style={{ width: `${downloadProgress}%` }} />
              </div>
              <span className="tidal-dl-progress-pct">{downloadProgress}%</span>
            </div>
            <div className="tidal-dl-actions">
              <button onClick={handleCancel}>Cancel</button>
            </div>
          </div>
        )}

        {/* RESULT STEP — Upgrade compare */}
        {step === "result" && upgradePreview && (
          <>
            <h3>Compare files</h3>
            <div className="tidal-dl-compare">
              <div className="tidal-dl-compare-col">
                <h4>Current file</h4>
                <div className="tidal-dl-field">
                  <span>Format</span>
                  <span>{upgradePreview.old_format?.toUpperCase() ?? "\u2014"}</span>
                </div>
                <div className="tidal-dl-field">
                  <span>Size</span>
                  <span>{formatFileSize(upgradePreview.old_file_size)}</span>
                </div>
              </div>
              <div className="tidal-dl-compare-arrow">{"\u2192"}</div>
              <div className="tidal-dl-compare-col">
                <h4>TIDAL version</h4>
                <div className="tidal-dl-field">
                  <span>Format</span>
                  <span>{upgradePreview.new_format?.toUpperCase() ?? "\u2014"}</span>
                </div>
                <div className="tidal-dl-field">
                  <span>Size</span>
                  <span>{formatFileSize(upgradePreview.new_file_size)}</span>
                </div>
              </div>
            </div>
            <div className="tidal-dl-actions">
              <button onClick={handleBackToSearch}>Back</button>
              <button className="tidal-dl-btn-primary" onClick={handleReplace} disabled={confirming}>
                {confirming ? "Replacing..." : "Replace"}
              </button>
              <button className="tidal-dl-btn-secondary" onClick={handleSaveAsCopy} disabled={confirming}>
                {confirming ? "Saving..." : "Save as Copy"}
              </button>
              <button onClick={handleCancel}>Cancel</button>
            </div>
          </>
        )}

        {/* RESULT STEP — Fresh download success */}
        {step === "result" && downloadResult && (
          <>
            <div className="tidal-dl-success">
              <h3>Download complete</h3>
              <div className="tidal-dl-field">
                <span>Format</span>
                <span>{downloadResult.format}</span>
              </div>
              <div className="tidal-dl-field">
                <span>Size</span>
                <span>{formatFileSize(downloadResult.file_size)}</span>
              </div>
              {addedToLibrary && <p>Added to library.</p>}
              <div className="tidal-dl-success-path">{downloadResult.path}</div>
            </div>
            <div className="tidal-dl-actions">
              <button className="tidal-dl-btn-primary" onClick={onClose}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
