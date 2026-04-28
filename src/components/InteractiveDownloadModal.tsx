import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { Track } from "../types";
import type { InteractiveSearchResult, DownloadResolveResult } from "../types/plugin";
import { formatDuration } from "../utils";
import type { AppStore } from "../store";
import "./InteractiveDownloadModal.css";

interface InteractiveDownloadModalProps {
  input: {
    trackId: number | null;
    title: string;
    artistName: string | null;
  };
  providerId: string;
  providerName: string;
  libraryTrack: Track | null;
  downloadFormat: string;
  collections: { id: number; name: string; path: string }[];
  store: AppStore;
  lastDest: string | null;
  onSearch: (query: string, limit: number) => Promise<InteractiveSearchResult[]>;
  onResolve: (matchId: string, format: string) => Promise<DownloadResolveResult>;
  onClose: () => void;
  onComplete: (message: string) => void;
  onPlay?: (path: string) => void;
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
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function InteractiveDownloadModal({
  input,
  providerId: _providerId,
  providerName,
  libraryTrack,
  downloadFormat,
  collections,
  store,
  lastDest,
  onSearch,
  onResolve,
  onClose,
  onComplete,
  onPlay,
}: InteractiveDownloadModalProps) {
  const [step, setStep] = useState<Step>("search");
  const [searchQuery, setSearchQuery] = useState(
    [input.title, input.artistName].filter(Boolean).join(" ")
  );
  const [results, setResults] = useState<InteractiveSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Configure state
  const [selectedMatch, setSelectedMatch] = useState<InteractiveSearchResult | null>(null);
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
  const [resolvedCoverUrl, setResolvedCoverUrl] = useState<string | null>(null);
  const [resolvedTitle, setResolvedTitle] = useState<string | null>(null);
  const [resolvedArtist, setResolvedArtist] = useState<string | null>(null);
  const [resolvedAlbum, setResolvedAlbum] = useState<string | null>(null);
  const [resolvedTrackNumber, setResolvedTrackNumber] = useState<number | null>(null);

  // Download state
  const [downloadProgress, setDownloadProgress] = useState(0);

  // Result state
  const [upgradePreview, setUpgradePreview] = useState<UpgradePreviewInfo | null>(null);
  const [downloadResult, setDownloadResult] = useState<DownloadResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [addedToLibrary, setAddedToLibrary] = useState(false);

  // Adaptive column detection
  const hasArt = results.some(r => r.coverUrl);
  const hasArtist = results.some(r => r.artistName);
  const hasAlbum = results.some(r => r.albumTitle);
  const hasDuration = results.some(r => r.durationSecs);

  // Auto-search on mount
  const didAutoSearch = useRef(false);
  useEffect(() => {
    if (didAutoSearch.current) return;
    didAutoSearch.current = true;
    if (!searchQuery) {
      setSearchError("No title or artist to search for");
      return;
    }
    handleSearch(searchQuery);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSearch(query?: string) {
    const q = query ?? searchQuery;
    setSearching(true);
    setSearchError(null);
    setResults([]);
    try {
      const r = await onSearch(q, 10);
      setResults(r);
    } catch (e) {
      setSearchError(String(e));
    } finally {
      setSearching(false);
    }
  }

  function handleSelectMatch(match: InteractiveSearchResult) {
    setSelectedMatch(match);
    setStep("configure");
    setError(null);
  }

  function getEffectiveTitle(): string {
    return resolvedTitle || selectedMatch?.title || input.title;
  }

  function getEffectiveArtist(): string | null {
    return resolvedArtist || selectedMatch?.artistName || input.artistName || null;
  }

  function getEffectiveAlbum(): string | null {
    return resolvedAlbum || selectedMatch?.albumTitle || null;
  }

  function getEffectiveTrackNumber(): number | null {
    return resolvedTrackNumber ?? selectedMatch?.trackNumber ?? null;
  }

  function getEffectiveCoverUrl(): string | null {
    return resolvedCoverUrl || selectedMatch?.coverUrl || null;
  }

  async function handleStartDownload() {
    if (!selectedMatch) return;
    setError(null);

    // Resolve stream URL and metadata from the provider
    let streamUrl: string;
    try {
      const resolved = await onResolve(selectedMatch.id, quality);
      streamUrl = resolved.url;
      // Merge metadata: resolve overrides search result
      setResolvedCoverUrl(resolved.metadata?.coverUrl || selectedMatch.coverUrl || null);
      setResolvedTitle(resolved.metadata?.title || selectedMatch.title);
      setResolvedArtist(resolved.metadata?.artist || selectedMatch.artistName || null);
      setResolvedAlbum(resolved.metadata?.album || selectedMatch.albumTitle || null);
      setResolvedTrackNumber(resolved.metadata?.trackNumber ?? selectedMatch.trackNumber ?? null);
    } catch (e) {
      setError(`Failed to resolve stream: ${String(e)}`);
      setStep("configure");
      return;
    }

    const effectiveCoverUrl = resolvedCoverUrl || selectedMatch.coverUrl || null;
    const effectiveTitle = resolvedTitle || selectedMatch.title;
    const effectiveArtist = resolvedArtist || selectedMatch.artistName || null;
    const effectiveAlbum = resolvedAlbum || selectedMatch.albumTitle || null;
    const effectiveTrackNumber = resolvedTrackNumber ?? selectedMatch.trackNumber ?? null;

    setResolvedStreamUrl(streamUrl);

    if (isUpgrade && !showDestPicker) {
      // Upgrade path: download preview next to original file
      setStep("downloading");
      try {
        const info = await invoke<UpgradePreviewInfo>("download_preview", {
          trackId: input.trackId,
          streamUrl,
          format: quality,
          title: effectiveTitle,
          artistName: effectiveArtist,
          albumTitle: effectiveAlbum,
          trackNumber: effectiveTrackNumber,
          coverUrl: effectiveCoverUrl,
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
        artistName: effectiveArtist ?? "Unknown",
        trackTitle: effectiveTitle,
        destDir,
        format: quality,
      });

      if (check.has_conflict) {
        setConflict(check);
        setStep("conflict");
      } else {
        await doFreshDownload(check.dest_path, false, streamUrl, effectiveCoverUrl ?? undefined);
      }
    } catch {
      // Treat conflict check errors as no conflict
      const ext = quality === "flac" ? "flac" : "m4a";
      const fallbackPath = `${destDir}/${effectiveArtist ?? "Unknown"} - ${effectiveTitle}.${ext}`;
      await doFreshDownload(fallbackPath, false, streamUrl, effectiveCoverUrl ?? undefined);
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
    store.set("lastDownloadDest", collId != null ? String(collId) : null);

    const cover = coverUrlArg || getEffectiveCoverUrl();

    try {
      const result = await invoke<DownloadResult>("download_to_path", {
        streamUrl: url,
        destPath: dp,
        format: quality,
        overwrite,
        title: getEffectiveTitle(),
        artistName: getEffectiveArtist(),
        albumTitle: getEffectiveAlbum(),
        trackNumber: getEffectiveTrackNumber(),
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
      onComplete(`Track replaced with ${providerName} version`);
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
      onComplete(`${providerName} copy saved alongside original`);
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
    setResolvedStreamUrl(null);
    setResolvedCoverUrl(null);
    setResolvedTitle(null);
    setResolvedArtist(null);
    setResolvedAlbum(null);
    setResolvedTrackNumber(null);
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
        <h2 className="ds-modal-title">{isUpgrade && !showDestPicker ? `Upgrade via ${providerName}` : `Download from ${providerName}`}</h2>
        <p className="tidal-dl-track">
          {input.title}{input.artistName ? ` — ${input.artistName}` : ""}
        </p>

        {error && <div className="tidal-dl-error">{error}</div>}

        {/* SEARCH STEP */}
        {step === "search" && (
          <>
            <div className="tidal-dl-search-field">
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
                placeholder={`Search ${providerName}...`}
              />
              <button onClick={() => handleSearch()} disabled={searching}>Search</button>
            </div>
            {searching ? (
              <div className="tidal-dl-loading"><div className="tidal-dl-spinner" /><span>Searching {providerName}...</span></div>
            ) : searchError ? (
              <div className="tidal-dl-error">{searchError}</div>
            ) : results.length === 0 && !searching ? (
              <div className="tidal-dl-empty">No matches found on {providerName}</div>
            ) : (
              <div className="tidal-dl-results">
                {results.map((t) => (
                  <div key={t.id} className="tidal-dl-result" onClick={() => handleSelectMatch(t)}>
                    {hasArt && (
                      <div className="tidal-dl-result-art">
                        {t.coverUrl ? (
                          <img src={t.coverUrl} alt="" />
                        ) : (
                          <div className="tidal-art-placeholder" />
                        )}
                      </div>
                    )}
                    <div className="tidal-dl-result-info">
                      <span className="tidal-dl-result-title">{t.title}</span>
                      {(hasArtist || hasAlbum) && (
                        <span className="tidal-dl-result-meta">
                          {t.artistName}{t.albumTitle ? ` — ${t.albumTitle}` : ""}
                        </span>
                      )}
                    </div>
                    {hasDuration && (
                      <span className="tidal-dl-result-duration">
                        {t.durationSecs ? formatDuration(t.durationSecs) : ""}
                      </span>
                    )}
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
              {selectedMatch.coverUrl && (
                <img src={selectedMatch.coverUrl} alt="" />
              )}
              <div className="tidal-dl-selected-info">
                <span className="tidal-dl-result-title">{selectedMatch.title}</span>
                <span className="tidal-dl-result-meta">
                  {selectedMatch.artistName}{selectedMatch.albumTitle ? ` — ${selectedMatch.albumTitle}` : ""}
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
            <div className="tidal-dl-loading"><div className="tidal-dl-spinner" /><span>Downloading from {providerName}...</span></div>
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
                  <span>{upgradePreview.old_format?.toUpperCase() ?? "—"}</span>
                </div>
                <div className="tidal-dl-field">
                  <span>Size</span>
                  <span>{formatFileSize(upgradePreview.old_file_size)}</span>
                </div>
              </div>
              <div className="tidal-dl-compare-arrow">{"→"}</div>
              <div className="tidal-dl-compare-col">
                <h4>{providerName} version</h4>
                <div className="tidal-dl-field">
                  <span>Format</span>
                  <span>{upgradePreview.new_format?.toUpperCase() ?? "—"}</span>
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
              <button onClick={() => invoke("show_in_folder_path", { filePath: downloadResult.path }).catch(console.error)}>
                Show in Folder
              </button>
              {onPlay && (
                <button onClick={() => { onPlay(downloadResult.path); onClose(); }}>
                  Play
                </button>
              )}
              <button className="tidal-dl-btn-primary" onClick={onClose}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
