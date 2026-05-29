import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { InteractiveSearchResult, DownloadResolveResult, DownloadQualityOption } from "../../types/plugin";
import { formatDuration, formatFileSize } from "../../utils";
import type { AppStore } from "../../store";
import type { DownloadTrack, UpgradePreviewInfo, ConflictCheck, DownloadResult } from "./types";

type SingleStep = "search" | "configure" | "conflict" | "downloading" | "result";

export function SingleTrackDownload({
  track,
  providerId: _providerId,
  providerName,
  resolveByUri,
  downloadFormat,
  qualityOptions,
  collections,
  downloadsCollectionId,
  store,
  lastDest,
  onSearch,
  onResolve,
  onClose,
  onComplete,
  onPlay,
}: {
  track: DownloadTrack;
  providerId: string;
  providerName: string;
  resolveByUri?: (uri: string, format: string) => Promise<DownloadResolveResult | null>;
  downloadFormat: string;
  qualityOptions?: DownloadQualityOption[] | null;
  collections: { id: number; name: string; path: string }[];
  downloadsCollectionId?: number | null;
  store: AppStore;
  lastDest: string | null;
  onSearch: (query: string, limit: number) => Promise<InteractiveSearchResult[]>;
  onResolve: (matchId: string, format: string) => Promise<DownloadResolveResult>;
  onClose: () => void;
  onComplete: (message: string) => void;
  onPlay?: (path: string) => void;
}) {
  const directUri = !!(resolveByUri && track.uri);
  const [step, setStep] = useState<SingleStep>(directUri ? "configure" : "search");
  const [searchQuery, setSearchQuery] = useState(
    [track.title, track.artistName].filter(Boolean).join(" ")
  );
  const [results, setResults] = useState<InteractiveSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Configure state
  const [selectedMatch, setSelectedMatch] = useState<InteractiveSearchResult | null>(() => {
    if (directUri) {
      return {
        id: track.uri!,
        title: track.title,
        artistName: track.artistName ?? undefined,
        albumTitle: track.albumTitle ?? undefined,
        durationSecs: track.durationSecs ?? undefined,
      };
    }
    return null;
  });
  const defaultQualities: DownloadQualityOption[] = [
    { value: "flac", label: "FLAC (Lossless)" },
    { value: "aac", label: "AAC (320kbps)" },
  ];
  const qualities = qualityOptions && qualityOptions.length > 0 ? qualityOptions : defaultQualities;
  const hasProviderQualities = !!(qualityOptions && qualityOptions.length > 0);

  const [quality, setQualityState] = useState<string>(() => {
    if (hasProviderQualities) return qualities[0].value;
    return downloadFormat === "flac" ? "flac" : "aac";
  });
  const setQuality = (q: string) => {
    setQualityState(q);
    if (!hasProviderQualities) store.set("lastDownloadQuality", q);
  };

  useEffect(() => {
    if (hasProviderQualities) return;
    store.get<string>("lastDownloadQuality").then(saved => {
      if (saved && qualities.some(q => q.value === saved)) setQualityState(saved);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Determine if this is an upgrade flow
  const isUpgrade = track.trackId != null;
  const [showDestPicker, setShowDestPicker] = useState(!isUpgrade);
  const [destType, setDestType] = useState<"collection" | "path">("collection");
  const [destCollectionId, setDestCollectionId] = useState<number | null>(() => {
    if (lastDest) {
      const parsed = parseInt(lastDest, 10);
      if (!isNaN(parsed) && collections.some(c => c.id === parsed)) return parsed;
    }
    if (downloadsCollectionId != null && collections.some(c => c.id === downloadsCollectionId)) return downloadsCollectionId;
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
  const [resolving, setResolving] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);

  // Result state
  const [upgradePreview, setUpgradePreview] = useState<UpgradePreviewInfo | null>(null);
  const [downloadResult, setDownloadResult] = useState<DownloadResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [addedToLibrary, setAddedToLibrary] = useState(false);

  // Callback refs to avoid stale closures
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;
  const onResolveRef = useRef(onResolve);
  onResolveRef.current = onResolve;

  // Adaptive column detection
  const hasArt = results.some(r => r.coverUrl);
  const hasArtist = results.some(r => r.artistName);
  const hasAlbum = results.some(r => r.albumTitle);
  const hasDuration = results.some(r => r.durationSecs);

  // Auto-search on mount (skipped in direct URI mode)
  const didAutoSearch = useRef(false);
  useEffect(() => {
    if (directUri) return;
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
      const r = await onSearchRef.current(q, 10);
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
    return resolvedTitle || selectedMatch?.title || track.title;
  }

  function getEffectiveArtist(): string | null {
    return resolvedArtist || selectedMatch?.artistName || track.artistName || null;
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
    setResolving(true);

    // Resolve stream URL and metadata from the provider
    let streamUrl: string;
    try {
      if (directUri && resolveByUri && track.uri) {
        const resolved = await resolveByUri(track.uri, quality);
        if (!resolved) {
          setResolving(false);
          setError("Provider could not resolve this track for download");
          return;
        }
        streamUrl = resolved.url;
        setResolvedCoverUrl(resolved.metadata?.coverUrl || null);
        setResolvedTitle(resolved.metadata?.title || selectedMatch.title);
        setResolvedArtist(resolved.metadata?.artist || selectedMatch.artistName || null);
        setResolvedAlbum(resolved.metadata?.album || selectedMatch.albumTitle || null);
        setResolvedTrackNumber(resolved.metadata?.trackNumber ?? null);
      } else {
        const resolved = await onResolveRef.current(selectedMatch.id, quality);
        streamUrl = resolved.url;
        setResolvedCoverUrl(resolved.metadata?.coverUrl || selectedMatch.coverUrl || null);
        setResolvedTitle(resolved.metadata?.title || selectedMatch.title);
        setResolvedArtist(resolved.metadata?.artist || selectedMatch.artistName || null);
        setResolvedAlbum(resolved.metadata?.album || selectedMatch.albumTitle || null);
        setResolvedTrackNumber(resolved.metadata?.trackNumber ?? selectedMatch.trackNumber ?? null);
      }
    } catch (e) {
      setResolving(false);
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
      setResolving(false);
      try {
        const info = await invoke<UpgradePreviewInfo>("download_preview", {
          trackId: track.trackId,
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
      setResolving(false);
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
        setResolving(false);
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
      setResolving(false);
      setError("No stream URL available");
      return;
    }
    setResolving(false);
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
          // Non-blocking -- file is saved, just not indexed
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
    // Best-effort cleanup — modal is closing regardless
    if (step === "downloading") {
      await invoke("cancel_direct_download").catch(console.error);
    }
    if (upgradePreview) {
      await invoke("cancel_track_upgrade", { newPath: upgradePreview.new_path }).catch(console.error);
    }
    onClose();
  }

  async function handleReplace() {
    if (!upgradePreview) return;
    setConfirming(true);
    try {
      await invoke("confirm_track_upgrade", {
        trackId: track.trackId,
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
        trackId: track.trackId,
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
      await invoke("cancel_track_upgrade", { newPath: upgradePreview.new_path }).catch(console.error);
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
    <>
      <h2 className="ds-modal-title">{isUpgrade && !showDestPicker ? `Upgrade via ${providerName}` : `Download from ${providerName}`}</h2>
      <p className="dl-track">
        {track.title}{track.artistName ? ` — ${track.artistName}` : ""}
      </p>

      {error && <div className="dl-error">{error}</div>}

      {/* SEARCH STEP */}
      {step === "search" && (
        <>
          <div className="dl-search-field">
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
              placeholder={`Search ${providerName}...`}
            />
            <button onClick={() => handleSearch()} disabled={searching}>Search</button>
          </div>
          {searching ? (
            <div className="dl-loading"><div className="ds-spinner" /><span>Searching {providerName}...</span></div>
          ) : searchError ? (
            <div className="dl-error">{searchError}</div>
          ) : results.length === 0 && !searching ? (
            <div className="dl-empty">No matches found on {providerName}</div>
          ) : (
            <div className="dl-results">
              {results.map((t) => (
                <div key={t.id} className="dl-result" onClick={() => handleSelectMatch(t)}>
                  {hasArt && (
                    <div className="dl-result-art">
                      {t.coverUrl ? (
                        <img src={t.coverUrl} alt="" />
                      ) : (
                        <div className="dl-art-placeholder" />
                      )}
                    </div>
                  )}
                  <div className="dl-result-info">
                    <span className="dl-result-title">{t.title}</span>
                    {(hasArtist || hasAlbum) && (
                      <span className="dl-result-meta">
                        {t.artistName}{t.albumTitle ? ` — ${t.albumTitle}` : ""}
                      </span>
                    )}
                  </div>
                  {hasDuration && (
                    <span className="dl-result-duration">
                      {t.durationSecs ? formatDuration(t.durationSecs) : ""}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="dl-actions">
            <button onClick={handleCancel}>Cancel</button>
          </div>
        </>
      )}

      {/* CONFIGURE STEP */}
      {step === "configure" && selectedMatch && (
        <>
          <div className="dl-selected">
            {selectedMatch.coverUrl && (
              <img src={selectedMatch.coverUrl} alt="" />
            )}
            <div className="dl-selected-info">
              <span className="dl-result-title">{selectedMatch.title}</span>
              <span className="dl-result-meta">
                {selectedMatch.artistName}{selectedMatch.albumTitle ? ` — ${selectedMatch.albumTitle}` : ""}
              </span>
            </div>
          </div>

          <div className="dl-config-row">
            <label>Quality</label>
            {qualities.length === 1 ? (
              <span>{qualities[0].label}</span>
            ) : (
              <select value={quality} onChange={(e) => setQuality(e.target.value)}>
                {qualities.map(q => (
                  <option key={q.value} value={q.value}>{q.label}</option>
                ))}
              </select>
            )}
          </div>

          {isUpgrade && !showDestPicker && (
            <button className="dl-save-elsewhere" onClick={() => setShowDestPicker(true)}>
              Save elsewhere instead...
            </button>
          )}

          {showDestPicker && (
            <div className="dl-config-row">
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
                {downloadsCollectionId != null && collections.find(c => c.id === downloadsCollectionId) && (
                  <option value={String(downloadsCollectionId)}>
                    Downloads Folder {"—"} {collections.find(c => c.id === downloadsCollectionId)!.path}
                  </option>
                )}
                {collections.filter(c => c.id !== downloadsCollectionId).map(c => (
                  <option key={c.id} value={String(c.id)}>{c.name} {"—"} {c.path}</option>
                ))}
                <option value="__browse__">Browse to folder...</option>
              </select>
            </div>
          )}

          {destType === "path" && destPath && showDestPicker && (
            <div className="dl-config-row">
              <label />
              <span className="dl-dest-display">{destPath}</span>
            </div>
          )}

          {resolving && (
            <div className="dl-resolving"><div className="ds-spinner ds-spinner--sm" /><span>Preparing download...</span></div>
          )}

          <div className="dl-actions">
            <button onClick={directUri ? onClose : handleBackToSearch} disabled={resolving}>
              {directUri ? "Cancel" : "Back"}
            </button>
            <button className="dl-btn-primary" onClick={handleStartDownload} disabled={resolving}>
              {resolving ? "Resolving..." : "Download"}
            </button>
          </div>
        </>
      )}

      {/* CONFLICT STEP */}
      {step === "conflict" && conflict && (
        <>
          <div className="dl-conflict">
            <div className="dl-conflict-filename">
              &ldquo;{conflict.dest_path.split(/[\\/]/).pop()}&rdquo; already exists
            </div>
            <div className="dl-conflict-size">
              Existing file: {conflict.existing_format ?? "Unknown"}, {formatFileSize(conflict.existing_size)}
            </div>
          </div>
          <div className="dl-actions">
            <button onClick={() => { setConflict(null); setStep("configure"); }}>Cancel</button>
            <button className="dl-btn-secondary" onClick={handleConflictKeepBoth}>Keep Both</button>
            <button className="dl-btn-primary" onClick={handleConflictReplace}>Replace</button>
          </div>
        </>
      )}

      {/* DOWNLOADING STEP */}
      {step === "downloading" && (
        <div className="dl-downloading">
          <div className="dl-loading"><div className="ds-spinner" /><span>Downloading from {providerName}...</span></div>
          <div className="dl-progress">
            <div className="dl-progress-bar">
              <div className="dl-progress-fill" style={{ width: `${downloadProgress}%` }} />
            </div>
            <span className="dl-progress-pct">{downloadProgress}%</span>
          </div>
          <div className="dl-actions">
            <button onClick={handleCancel}>Cancel</button>
          </div>
        </div>
      )}

      {/* RESULT STEP -- Upgrade compare */}
      {step === "result" && upgradePreview && (
        <>
          <h3>Compare files</h3>
          <div className="dl-compare">
            <div className="dl-compare-col">
              <h4>Current file</h4>
              <div className="dl-field">
                <span>Format</span>
                <span>{upgradePreview.old_format?.toUpperCase() ?? "—"}</span>
              </div>
              <div className="dl-field">
                <span>Size</span>
                <span>{formatFileSize(upgradePreview.old_file_size)}</span>
              </div>
            </div>
            <div className="dl-compare-arrow">{"→"}</div>
            <div className="dl-compare-col">
              <h4>{providerName} version</h4>
              <div className="dl-field">
                <span>Format</span>
                <span>{upgradePreview.new_format?.toUpperCase() ?? "—"}</span>
              </div>
              <div className="dl-field">
                <span>Size</span>
                <span>{formatFileSize(upgradePreview.new_file_size)}</span>
              </div>
            </div>
          </div>
          <div className="dl-actions">
            <button onClick={handleBackToSearch}>Back</button>
            <button className="dl-btn-primary" onClick={handleReplace} disabled={confirming}>
              {confirming ? "Replacing..." : "Replace"}
            </button>
            <button className="dl-btn-secondary" onClick={handleSaveAsCopy} disabled={confirming}>
              {confirming ? "Saving..." : "Save as Copy"}
            </button>
            <button onClick={handleCancel}>Cancel</button>
          </div>
        </>
      )}

      {/* RESULT STEP -- Fresh download success */}
      {step === "result" && downloadResult && (
        <>
          <div className="dl-success">
            <h3>Download complete</h3>
            <div className="dl-field">
              <span>Format</span>
              <span>{downloadResult.format}</span>
            </div>
            <div className="dl-field">
              <span>Size</span>
              <span>{formatFileSize(downloadResult.file_size)}</span>
            </div>
            {addedToLibrary && <p>Added to library.</p>}
            <div className="dl-success-path">{downloadResult.path}</div>
          </div>
          <div className="dl-actions">
            <button onClick={() => invoke("show_in_folder_path", { filePath: downloadResult.path }).catch(console.error)}>
              Show in Folder
            </button>
            {onPlay && (
              <button onClick={() => { onPlay(downloadResult.path); onClose(); }}>
                Play
              </button>
            )}
            <button className="dl-btn-primary" onClick={onClose}>Done</button>
          </div>
        </>
      )}
    </>
  );
}
