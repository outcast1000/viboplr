import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { Track } from "../types";
import type { InteractiveSearchResult, DownloadResolveResult, DownloadQualityOption } from "../types/plugin";
import { formatDuration } from "../utils";
import type { AppStore } from "../store";
import { IconPlay, IconFolder } from "./Icons";
import "./DownloadModal.css";

// -- Shared types --

export interface DownloadTrack {
  title: string;
  artistName?: string | null;
  albumTitle?: string | null;
  uri?: string | null;
  durationSecs?: number | null;
  trackId?: number | null;
}

interface DownloadModalProps {
  tracks: DownloadTrack[];
  providerId: string;
  providerName: string;
  confirmed?: boolean;
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
}

// -- Shared internal types --

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

type ExistingAction = "skip" | "download" | "overwrite";

interface ResolveState {
  originalTrack: DownloadTrack;
  status: "pending" | "searching" | "matched" | "not_found";
  match?: InteractiveSearchResult | null;
  libraryTrack?: Track | null;
  existingAction?: ExistingAction;
}

type BatchDownloadStatus = "queued" | "downloading" | "done" | "error" | "skipped";

interface BatchDownloadTrackState {
  index: number;
  title: string;
  artist: string;
  status: BatchDownloadStatus;
  progress: number;
  error?: string;
  filePath?: string;
}

interface BatchConflict {
  trackIndex: number;
  destPath: string;
  existingSize: number | null;
  existingFormat: string | null;
  altPath: string;
}

// -- Helpers --

function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const PATH_PATTERNS = [
  { value: "[artist]/[album]/[track_number] - [title]", label: "Artist / Album / 01 - Title" },
  { value: "[artist] - [album]/[track_number] - [title]", label: "Artist - Album / 01 - Title" },
  { value: "[artist]/[album]/[artist] - [track_number] - [title]", label: "Artist / Album / Artist - 01 - Title" },
  { value: "[artist] - [album] - [track_number] - [title]", label: "Artist - Album - 01 - Title (flat)" },
];

function previewPattern(pattern: string, artist: string, album: string, title: string, ext: string): string {
  return pattern
    .replace(/\[artist\]/g, artist || "Artist")
    .replace(/\[album\]/g, album || "Album")
    .replace(/\[track_number\]/g, "01")
    .replace(/\[title\]/g, title || "Track Name")
    + "." + ext;
}

function buildDestPath(
  collectionPath: string,
  pattern: string,
  title: string,
  artist: string,
  album: string,
  trackNumber: number | null,
  ext: string
): string {
  const sanitize = (s: string) => s.replace(/[/\\:*?"<>|]/g, "_").trim() || "Unknown";
  const num = trackNumber ? String(trackNumber).padStart(2, "0") : "";
  const expanded = pattern
    .replace(/\[artist\]/g, sanitize(artist))
    .replace(/\[album\]/g, sanitize(album))
    .replace(/\[track_number\]/g, num)
    .replace(/\[title\]/g, sanitize(title));
  return collectionPath + "/" + expanded + "." + ext;
}

// =============================================================================
// Single-track download mode
// =============================================================================

type SingleStep = "search" | "configure" | "conflict" | "downloading" | "result";

function SingleTrackDownload({
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

// =============================================================================
// Multi-track (batch) download mode
// =============================================================================

type BatchStep = "configure" | "resolve" | "review" | "downloading" | "done";

function MultiTrackDownload({
  tracks,
  providerId: _providerId,
  providerName,
  confirmed,
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
  tracks: DownloadTrack[];
  providerId: string;
  providerName: string;
  confirmed?: boolean;
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
  const defaultQualities: DownloadQualityOption[] = [
    { value: "flac", label: "FLAC (Lossless)" },
    { value: "aac", label: "AAC (320kbps)" },
  ];
  const qualities = qualityOptions && qualityOptions.length > 0 ? qualityOptions : defaultQualities;
  const hasProviderQualities = !!(qualityOptions && qualityOptions.length > 0);

  const [step, setStep] = useState<BatchStep>("configure");
  const [quality, setQualityState] = useState<string>(
    hasProviderQualities ? qualities[0].value : (downloadFormat === "flac" ? "flac" : "aac")
  );
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
  const [pathPattern, setPathPattern] = useState(PATH_PATTERNS[0].value);

  // Resolve step state
  const [resolveStates, setResolveStates] = useState<ResolveState[]>([]);
  const cancelledRef = useRef(false);

  // Review step state
  const [manualSearchIndex, setManualSearchIndex] = useState<number | null>(null);
  const [manualQuery, setManualQuery] = useState("");
  const [manualResults, setManualResults] = useState<InteractiveSearchResult[]>([]);
  const [manualSearching, setManualSearching] = useState(false);

  // Download step state
  const [downloadStates, setDownloadStates] = useState<BatchDownloadTrackState[]>([]);
  const [batchConflict, _setBatchConflict] = useState<BatchConflict | null>(null);
  const [upgradeComparison, setUpgradeComparison] = useState<{
    trackIndex: number;
    title: string;
    info: UpgradePreviewInfo;
  } | null>(null);
  const upgradeResolveRef = useRef<((decision: "replace" | "copy" | "skip") => void) | null>(null);
  const conflictResolveRef = useRef<((decision: "replace" | "keep_both" | "skip") => void) | null>(null);

  // Callback refs -- critical to prevent stale closures in resolve useEffect
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;
  const onResolveRef = useRef(onResolve);
  onResolveRef.current = onResolve;

  // Single resolve guard for strict mode
  const resolveGuard = useRef(false);

  // Resolve step: auto-search each track sequentially
  useEffect(() => {
    if (step !== "resolve") return;
    if (resolveGuard.current) return;
    resolveGuard.current = true;
    cancelledRef.current = false;

    async function runResolve() {
      const initial: ResolveState[] = tracks.map(t => ({
        originalTrack: t,
        status: "pending",
        match: null,
      }));
      setResolveStates(initial);

      for (let i = 0; i < tracks.length; i++) {
        if (cancelledRef.current) break;

        setResolveStates(prev => prev.map((s, idx) =>
          idx === i ? { ...s, status: "searching" } : s
        ));

        try {
          const query = [tracks[i].title, tracks[i].artistName].filter(Boolean).join(" ");
          const results = await onSearchRef.current(query, 5);
          const match = results.length > 0 ? results[0] : null;

          let libraryMatch: Track | null = null;
          if (match) {
            try {
              libraryMatch = await invoke<Track | null>("find_track_by_metadata", {
                title: match.title ?? tracks[i].title,
                artistName: match.artistName ?? tracks[i].artistName ?? null,
                albumName: null,
              });
            } catch { /* no match */ }
          }

          setResolveStates(prev => prev.map((s, idx) =>
            idx === i ? {
              ...s,
              status: match ? "matched" : "not_found",
              match,
              libraryTrack: libraryMatch,
              existingAction: libraryMatch ? "skip" : undefined,
            } : s
          ));
        } catch (err) {
          console.error("Failed to resolve track:", err);
          setResolveStates(prev => prev.map((s, idx) =>
            idx === i ? { ...s, status: "not_found", match: null } : s
          ));
        }

        if (i < tracks.length - 1 && !cancelledRef.current) {
          await new Promise(r => setTimeout(r, 200));
        }
      }

      if (!cancelledRef.current) {
        setStep("review");
      }
    }

    runResolve();

    return () => {
      cancelledRef.current = true;
    };
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // Download step: sequential download_to_path for each track
  const downloadGuard = useRef(false);
  useEffect(() => {
    if (step !== "downloading") return;
    if (downloadGuard.current) return;
    downloadGuard.current = true;
    cancelledRef.current = false;

    (async () => {
      // Build the list of tracks to download
      const toDownload = confirmed
        ? tracks.map((t, i) => ({
            index: i,
            title: t.title,
            artistName: t.artistName ?? null,
            albumTitle: t.albumTitle ?? null,
            uri: t.uri ?? null,
            durationSecs: t.durationSecs ?? null,
            matchId: t.uri ?? null,
            coverUrl: null as string | null,
            trackNumber: null as number | null,
            existingAction: undefined as ExistingAction | undefined,
            libraryPath: null as string | null,
            libraryTrackId: null as number | null,
          }))
        : resolveStates
            .map((s, i) => ({ s, i }))
            .filter(({ s }) => s.status === "matched" && s.match && (!s.libraryTrack || s.existingAction !== "skip"))
            .map(({ s, i }) => ({
              index: i,
              title: s.match!.title ?? s.originalTrack.title,
              artistName: s.match!.artistName ?? s.originalTrack.artistName ?? null,
              albumTitle: s.originalTrack.albumTitle ?? s.match!.albumTitle ?? null,
              uri: s.originalTrack.uri ?? s.match!.id,
              durationSecs: s.match!.durationSecs ?? s.originalTrack.durationSecs ?? null,
              matchId: s.match!.id,
              coverUrl: s.match!.coverUrl ?? null,
              trackNumber: s.match!.trackNumber ?? null,
              existingAction: s.existingAction,
              libraryPath: s.libraryTrack?.path ?? null,
              libraryTrackId: s.libraryTrack?.id ?? null,
            }));

      // Save last used destination
      const collId = destType === "collection" ? destCollectionId : null;
      store.set("lastDownloadDest", collId != null ? String(collId) : null);

      // Resolve destination base path
      let basePath: string;
      if (destType === "collection" && destCollectionId != null) {
        const coll = collections.find(c => c.id === destCollectionId);
        basePath = coll?.path ?? "";
      } else {
        basePath = destPath ?? "";
      }

      // Initialize download states
      setDownloadStates(toDownload.map((t, i) => ({
        index: i,
        title: t.title,
        artist: t.artistName ?? "",
        status: "queued",
        progress: 0,
      })));

      const ext = quality === "flac" ? "flac" : "m4a";

      // Set up progress listener
      const unlisten = await listen<number>("direct-download-progress", (event) => {
        setDownloadStates(prev => {
          const downloading = prev.find(s => s.status === "downloading");
          if (!downloading) return prev;
          return prev.map(s =>
            s.index === downloading.index ? { ...s, progress: event.payload } : s
          );
        });
      });

      try {
        for (let i = 0; i < toDownload.length; i++) {
          if (cancelledRef.current) break;

          const t = toDownload[i];
          setDownloadStates(prev => prev.map(s =>
            s.index === i ? { ...s, status: "downloading", progress: 0 } : s
          ));

          try {
            // Resolve the stream URL + metadata
            const resolved = await onResolveRef.current(t.matchId!, quality);
            const streamUrl = resolved.url;

            // Merge metadata
            const title = resolved.metadata?.title || t.title;
            const artistName = resolved.metadata?.artist || t.artistName;
            const albumTitle = resolved.metadata?.album || t.albumTitle;
            const trackNumber = resolved.metadata?.trackNumber ?? t.trackNumber;
            const coverUrl = resolved.metadata?.coverUrl || t.coverUrl;

            // Build destination path
            const dp = buildDestPath(
              basePath,
              pathPattern,
              title,
              artistName ?? "Unknown",
              albumTitle ?? "Unknown",
              trackNumber,
              ext
            );

            let finalPath = dp;

            // Overwrite flow: download preview, compare, then user decides
            if (t.existingAction === "overwrite" && t.libraryTrackId != null) {
              const info = await invoke<UpgradePreviewInfo>("download_preview", {
                trackId: t.libraryTrackId,
                streamUrl,
                format: quality,
                title,
                artistName,
                albumTitle,
                trackNumber,
                coverUrl: coverUrl ?? null,
              });

              setUpgradeComparison({ trackIndex: i, title: t.title, info });

              const decision = await new Promise<"replace" | "copy" | "skip">((resolve) => {
                upgradeResolveRef.current = resolve;
              });

              setUpgradeComparison(null);
              upgradeResolveRef.current = null;

              if (decision === "replace") {
                await invoke("confirm_track_upgrade", { trackId: t.libraryTrackId, newPath: info.new_path });
                setDownloadStates(prev => prev.map(s =>
                  s.index === i ? { ...s, status: "done", progress: 100, filePath: info.new_path } : s
                ));
              } else if (decision === "copy") {
                await invoke("save_track_as_copy", { trackId: t.libraryTrackId, newPath: info.new_path });
                setDownloadStates(prev => prev.map(s =>
                  s.index === i ? { ...s, status: "done", progress: 100, filePath: info.new_path } : s
                ));
              } else {
                await invoke("cancel_track_upgrade", { newPath: info.new_path }).catch(() => {});
                setDownloadStates(prev => prev.map(s =>
                  s.index === i ? { ...s, status: "skipped" } : s
                ));
              }
              continue;
            }

            // Normal download
            const result = await invoke<DownloadResult>("download_to_path", {
              streamUrl,
              destPath: finalPath,
              format: quality,
              overwrite: true,
              title,
              artistName,
              albumTitle,
              trackNumber,
              coverUrl: coverUrl ?? null,
            });

            // Index into library if downloaded to a collection
            if (destType === "collection" && destCollectionId != null) {
              try {
                await invoke("add_downloaded_track", {
                  path: result.path,
                  collectionId: destCollectionId,
                });
              } catch {
                // Non-blocking -- file saved, just not indexed
              }
            }

            setDownloadStates(prev => prev.map(s =>
              s.index === i ? { ...s, status: "done", progress: 100, filePath: result.path } : s
            ));
          } catch (err) {
            console.error("Failed to download track:", t.title, err);
            setDownloadStates(prev => prev.map(s =>
              s.index === i ? { ...s, status: "error", error: String(err) } : s
            ));
          }
        }
      } finally {
        unlisten();
      }

      setStep("done");
    })();

    return () => {
      cancelledRef.current = true;
    };
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleManualSearch(_index: number) {
    setManualSearching(true);
    try {
      const results = await onSearchRef.current(manualQuery, 10);
      setManualResults(results);
    } catch (err) {
      console.error("Failed to perform manual search:", err);
      setManualResults([]);
    } finally {
      setManualSearching(false);
    }
  }

  function handlePickManualMatch(index: number, match: InteractiveSearchResult) {
    setResolveStates(prev => prev.map((s, i) =>
      i === index ? { ...s, status: "matched", match } : s
    ));
    setManualSearchIndex(null);
    setManualQuery("");
    setManualResults([]);
  }

  async function handleBrowseFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      setDestType("path");
      setDestPath(selected);
      setDestCollectionId(null);
    }
  }

  function handleStart() {
    store.set("lastDownloadDest", destCollectionId != null ? String(destCollectionId) : null);
    if (confirmed) {
      setStep("downloading");
    } else {
      setStep("resolve");
    }
  }

  // Derive a representative artist/album from the first track for the preview
  const sampleArtist = tracks[0]?.artistName ?? "Artist";
  const sampleAlbum = tracks[0]?.albumTitle ?? "Album";
  const sampleTitle = tracks[0]?.title ?? "Track Name";
  const ext = quality === "flac" ? "flac" : "m4a";
  const preview = previewPattern(pathPattern, sampleArtist, sampleAlbum, sampleTitle, ext);

  return (
    <>
      <h2 className="ds-modal-title">
        Download {tracks.length} tracks from {providerName}
      </h2>

      {tracks.length === 0 && (
        <div className="dl-error">No tracks to download</div>
      )}

      {/* CONFIGURE STEP */}
      {step === "configure" && tracks.length > 0 && (
        <>
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

          {destType === "path" && destPath && (
            <div className="dl-config-row">
              <label />
              <span className="dl-dest-display">{destPath}</span>
            </div>
          )}

          <div className="dl-config-row">
            <label>File layout</label>
            <select value={pathPattern} onChange={(e) => setPathPattern(e.target.value)}>
              {PATH_PATTERNS.map(p => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>

          <div className="dl-config-row">
            <label />
            <span className="dl-dest-display" style={{ opacity: 0.7 }}>{preview}</span>
          </div>

          <div className="dl-actions">
            <button onClick={onClose}>Cancel</button>
            <button className="dl-btn-primary" onClick={handleStart}>
              Start Download
            </button>
          </div>
        </>
      )}

      {/* RESOLVE STEP */}
      {step === "resolve" && (
        <>
          <div className="dl-batch-list">
            {resolveStates.map((rs, i) => (
              <div key={i} className="dl-batch-row">
                <div className="dl-batch-status">
                  {rs.status === "searching" && <div className="ds-spinner ds-spinner--sm" />}
                  {rs.status === "matched" && <span style={{color: "var(--success)"}}>&#10003;</span>}
                  {rs.status === "not_found" && <span style={{color: "var(--error)"}}>&#10007;</span>}
                  {rs.status === "pending" && <span style={{color: "var(--text-tertiary)"}}>&#183;</span>}
                </div>
                <div className="dl-batch-info">
                  <div className="dl-batch-title">{rs.originalTrack.title}</div>
                  {rs.status === "matched" && rs.match && (
                    <div className="dl-batch-match">&rarr; {rs.match.title}{rs.match.artistName ? ` — ${rs.match.artistName}` : ""}</div>
                  )}
                  {rs.status === "not_found" && (
                    <div className="dl-batch-match">No match found</div>
                  )}
                  {rs.status === "searching" && (
                    <div className="dl-batch-match">Searching...</div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="dl-actions">
            <button onClick={() => { cancelledRef.current = true; onClose(); }}>Cancel</button>
          </div>
        </>
      )}

      {/* REVIEW STEP */}
      {step === "review" && (() => {
        const matchedCount = resolveStates.filter(s => s.status === "matched").length;
        const notFoundCount = resolveStates.filter(s => s.status === "not_found").length;
        const existingCount = resolveStates.filter(s => s.libraryTrack).length;
        const downloadableCount = resolveStates.filter(s =>
          s.status === "matched" && (!s.libraryTrack || s.existingAction !== "skip")
        ).length;

        return (
          <>
            {existingCount > 0 && (
              <div className="dl-error" style={{background: "color-mix(in srgb, var(--warning) 15%, transparent)", color: "var(--warning)"}}>
                {existingCount} track{existingCount > 1 ? "s" : ""} already in your library
              </div>
            )}
            <div className="dl-batch-list">
              {resolveStates.map((rs, i) => (
                <div key={i}>
                  <div className="dl-batch-row">
                    <div className="dl-batch-status">
                      {rs.status === "matched" && !rs.libraryTrack && <span style={{color: "var(--success)"}}>&#10003;</span>}
                      {rs.status === "matched" && rs.libraryTrack && <span style={{color: "var(--warning)"}}>&#9679;</span>}
                      {rs.status === "not_found" && <span style={{color: "var(--error)"}}>&#10007;</span>}
                    </div>
                    <div className="dl-batch-info">
                      <div className="dl-batch-title">{rs.originalTrack.title}</div>
                      {rs.status === "matched" && rs.match && (
                        <div className="dl-batch-match">
                          &rarr; {rs.match.title}{rs.match.artistName ? ` — ${rs.match.artistName}` : ""}
                          {rs.match.durationSecs ? ` (${formatDuration(rs.match.durationSecs)})` : ""}
                        </div>
                      )}
                      {rs.status === "matched" && rs.libraryTrack && (
                        <div className="dl-batch-match" style={{color: "var(--warning)"}}>
                          In library: {rs.libraryTrack.format?.toUpperCase() ?? "local"}
                          {rs.libraryTrack.file_size ? `, ${formatFileSize(rs.libraryTrack.file_size)}` : ""}
                          {rs.libraryTrack.duration_secs ? `, ${formatDuration(rs.libraryTrack.duration_secs)}` : ""}
                        </div>
                      )}
                      {rs.status === "not_found" && (
                        <div className="dl-batch-match">No match found</div>
                      )}
                    </div>
                    {rs.status === "matched" && rs.libraryTrack && (
                      <div className="dl-batch-action">
                        <select
                          value={rs.existingAction ?? "skip"}
                          onChange={e => {
                            const action = e.target.value as ExistingAction;
                            setResolveStates(prev => prev.map((s, idx) =>
                              idx === i ? { ...s, existingAction: action } : s
                            ));
                          }}
                          style={{fontSize: "var(--fs-xs)", padding: "2px 4px"}}
                        >
                          <option value="skip">Skip</option>
                          <option value="download">Download</option>
                          {rs.libraryTrack!.path?.startsWith("file://") && (
                            <option value="overwrite">Overwrite</option>
                          )}
                        </select>
                      </div>
                    )}
                    {rs.status === "not_found" && (
                      <div className="dl-batch-action">
                        <button className="dl-btn-small" onClick={() => {
                          setManualSearchIndex(manualSearchIndex === i ? null : i);
                          setManualQuery([rs.originalTrack.title, rs.originalTrack.artistName].filter(Boolean).join(" "));
                          setManualResults([]);
                        }}>
                          {manualSearchIndex === i ? "Close" : "Search"}
                        </button>
                      </div>
                    )}
                  </div>

                  {manualSearchIndex === i && (
                    <div className="dl-batch-inline-search">
                      <div className="dl-search-field">
                        <input
                          value={manualQuery}
                          onChange={e => setManualQuery(e.target.value)}
                          onKeyDown={e => { if (e.key === "Enter") handleManualSearch(i); }}
                          placeholder="Search..."
                        />
                        <button onClick={() => handleManualSearch(i)} disabled={manualSearching}>Search</button>
                      </div>
                      {manualSearching && <div className="dl-loading"><div className="ds-spinner ds-spinner--sm" /></div>}
                      {!manualSearching && manualResults.length > 0 && (
                        <div className="dl-batch-inline-results">
                          {manualResults.map(r => (
                            <div key={r.id} className="dl-batch-row" style={{cursor: "pointer"}} onClick={() => handlePickManualMatch(i, r)}>
                              <div className="dl-batch-info">
                                <div className="dl-batch-title">{r.title}</div>
                                <div className="dl-batch-match">{r.artistName}{r.albumTitle ? ` — ${r.albumTitle}` : ""}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {!manualSearching && manualResults.length === 0 && manualQuery && (
                        <div className="dl-empty" style={{padding: "8px"}}>No results</div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="dl-batch-footer">
              <span>
                {matchedCount} matched{notFoundCount > 0 ? `, ${notFoundCount} not found` : ""}
                {existingCount > 0 ? ` (${existingCount} existing)` : ""}
              </span>
            </div>

            <div className="dl-actions">
              <button onClick={onClose}>Cancel</button>
              <button className="dl-btn-primary" onClick={() => setStep("downloading")}
                disabled={downloadableCount === 0}>
                Download {downloadableCount} track{downloadableCount !== 1 ? "s" : ""}
              </button>
            </div>
          </>
        );
      })()}

      {/* DOWNLOADING STEP */}
      {step === "downloading" && (
        <>
          <div className="dl-batch-overall">
            <div className="dl-progress">
              <div className="dl-progress-bar">
                <div className="dl-progress-fill" style={{
                  width: `${downloadStates.length > 0
                    ? (downloadStates.filter(t => t.status === "done" || t.status === "error" || t.status === "skipped").length / downloadStates.length * 100)
                    : 0}%`
                }} />
              </div>
              <span className="dl-progress-pct">
                {downloadStates.filter(t => t.status === "done" || t.status === "error" || t.status === "skipped").length} / {downloadStates.length}
              </span>
            </div>
          </div>

          {/* Inline conflict UI */}
          {batchConflict && (
            <div className="dl-conflict">
              <div className="dl-conflict-filename">
                &ldquo;{batchConflict.destPath.split(/[\\/]/).pop()}&rdquo; already exists
              </div>
              <div className="dl-conflict-size">
                Existing file: {batchConflict.existingFormat ?? "Unknown"}, {formatFileSize(batchConflict.existingSize)}
              </div>
              <div className="dl-actions" style={{ marginTop: "12px", justifyContent: "center" }}>
                <button onClick={() => conflictResolveRef.current?.("skip")}>Skip</button>
                <button className="dl-btn-secondary" onClick={() => conflictResolveRef.current?.("keep_both")}>Keep Both</button>
                <button className="dl-btn-primary" onClick={() => conflictResolveRef.current?.("replace")}>Replace</button>
              </div>
            </div>
          )}

          {/* Inline upgrade comparison UI */}
          {upgradeComparison && (
            <div className="dl-conflict">
              <h4 style={{margin: "0 0 8px"}}>{upgradeComparison.title}</h4>
              <div className="dl-compare">
                <div className="dl-compare-col">
                  <h4>Current file</h4>
                  <div className="dl-field">
                    <span>Format</span>
                    <span>{upgradeComparison.info.old_format?.toUpperCase() ?? "—"}</span>
                  </div>
                  <div className="dl-field">
                    <span>Size</span>
                    <span>{formatFileSize(upgradeComparison.info.old_file_size)}</span>
                  </div>
                </div>
                <div className="dl-compare-arrow">{"→"}</div>
                <div className="dl-compare-col">
                  <h4>New version</h4>
                  <div className="dl-field">
                    <span>Format</span>
                    <span>{upgradeComparison.info.new_format?.toUpperCase() ?? "—"}</span>
                  </div>
                  <div className="dl-field">
                    <span>Size</span>
                    <span>{formatFileSize(upgradeComparison.info.new_file_size)}</span>
                  </div>
                </div>
              </div>
              <div className="dl-actions" style={{ marginTop: "12px", justifyContent: "center" }}>
                <button onClick={() => upgradeResolveRef.current?.("skip")}>Skip</button>
                <button className="dl-btn-secondary" onClick={() => upgradeResolveRef.current?.("copy")}>Save as Copy</button>
                <button className="dl-btn-primary" onClick={() => upgradeResolveRef.current?.("replace")}>Replace</button>
              </div>
            </div>
          )}

          <div className="dl-batch-list">
            {downloadStates.map((ds) => (
              <div key={ds.index} className="dl-batch-row">
                <div className="dl-batch-status">
                  {ds.status === "queued" && <span style={{color: "var(--text-tertiary)"}}>&#183;</span>}
                  {ds.status === "downloading" && <div className="ds-spinner ds-spinner--sm" />}
                  {ds.status === "done" && <span style={{color: "var(--success)"}}>&#10003;</span>}
                  {ds.status === "error" && <span style={{color: "var(--error)"}}>&#10007;</span>}
                  {ds.status === "skipped" && <span style={{color: "var(--text-tertiary)"}}>&ndash;</span>}
                </div>
                <div className="dl-batch-info">
                  <div className="dl-batch-title">{ds.title}</div>
                  {ds.artist && <div className="dl-batch-match">{ds.artist}</div>}
                  {ds.status === "error" && ds.error && (
                    <div className="dl-batch-match" style={{color: "var(--error)"}}>{ds.error}</div>
                  )}
                </div>
                {ds.status === "downloading" && (
                  <div className="dl-batch-progress">{ds.progress}%</div>
                )}
                {ds.status === "done" && ds.filePath && (
                  <div className="dl-batch-action" style={{display: "flex", gap: "4px"}}>
                    {onPlay && (
                      <button className="g-btn g-btn-xs" title="Play" onClick={() => onPlay(ds.filePath!)}>
                        <IconPlay size={10} />
                      </button>
                    )}
                    <button className="g-btn g-btn-xs" title="Show in Folder" onClick={() => invoke("show_in_folder_path", { filePath: ds.filePath }).catch(console.error)}>
                      <IconFolder size={10} />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="dl-actions">
            <button onClick={() => { cancelledRef.current = true; onClose(); }}>Cancel</button>
          </div>
        </>
      )}

      {/* DONE STEP */}
      {step === "done" && (() => {
        const doneCount = downloadStates.filter(t => t.status === "done").length;
        const errCount = downloadStates.filter(t => t.status === "error").length;
        const skippedCount = downloadStates.filter(t => t.status === "skipped").length;
        return (
          <>
            <div className="dl-batch-overall">
              <div className="dl-progress">
                <div className="dl-progress-bar">
                  <div className="dl-progress-fill" style={{ width: "100%" }} />
                </div>
                <span className="dl-progress-pct">
                  {doneCount} / {downloadStates.length}
                </span>
              </div>
            </div>

            <div className="dl-batch-list">
              {downloadStates.map((ds) => (
                <div key={ds.index} className="dl-batch-row">
                  <div className="dl-batch-status">
                    {ds.status === "done" && <span style={{color: "var(--success)"}}>&#10003;</span>}
                    {ds.status === "error" && <span style={{color: "var(--error)"}}>&#10007;</span>}
                    {ds.status === "skipped" && <span style={{color: "var(--text-tertiary)"}}>&ndash;</span>}
                  </div>
                  <div className="dl-batch-info">
                    <div className="dl-batch-title">{ds.title}</div>
                    {ds.artist && <div className="dl-batch-match">{ds.artist}</div>}
                    {ds.status === "error" && ds.error && (
                      <div className="dl-batch-match" style={{color: "var(--error)"}}>{ds.error}</div>
                    )}
                  </div>
                  {ds.status === "done" && ds.filePath && (
                    <div className="dl-batch-action" style={{display: "flex", gap: "4px"}}>
                      {onPlay && (
                        <button className="g-btn g-btn-xs" title="Play" onClick={() => onPlay(ds.filePath!)}>
                          <IconPlay size={10} />
                        </button>
                      )}
                      <button className="g-btn g-btn-xs" title="Show in Folder" onClick={() => invoke("show_in_folder_path", { filePath: ds.filePath }).catch(console.error)}>
                        <IconFolder size={10} />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="dl-batch-footer">
              <span>
                {doneCount} downloaded{errCount > 0 ? `, ${errCount} failed` : ""}{skippedCount > 0 ? `, ${skippedCount} skipped` : ""}
              </span>
            </div>

            <div className="dl-actions">
              <button className="dl-btn-primary" onClick={() => {
                onComplete(`Downloaded ${doneCount} of ${downloadStates.length} tracks`);
                onClose();
              }}>
                Done
              </button>
            </div>
          </>
        );
      })()}
    </>
  );
}

// =============================================================================
// Unified DownloadModal
// =============================================================================

export function DownloadModal({
  tracks,
  providerId,
  providerName,
  confirmed,
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
}: DownloadModalProps) {
  const isSingle = tracks.length === 1;

  return (
    <div className="ds-modal-overlay" onClick={onClose}>
      <div className="ds-modal dl-modal" onClick={(e) => e.stopPropagation()}>
        {isSingle ? (
          <SingleTrackDownload
            track={tracks[0]}
            providerId={providerId}
            providerName={providerName}
            resolveByUri={resolveByUri}
            downloadFormat={downloadFormat}
            qualityOptions={qualityOptions}
            collections={collections}
            downloadsCollectionId={downloadsCollectionId}
            store={store}
            lastDest={lastDest}
            onSearch={onSearch}
            onResolve={onResolve}
            onClose={onClose}
            onComplete={onComplete}
            onPlay={onPlay}
          />
        ) : (
          <MultiTrackDownload
            tracks={tracks}
            providerId={providerId}
            providerName={providerName}
            confirmed={confirmed}
            downloadFormat={downloadFormat}
            qualityOptions={qualityOptions}
            collections={collections}
            downloadsCollectionId={downloadsCollectionId}
            store={store}
            lastDest={lastDest}
            onSearch={onSearch}
            onResolve={onResolve}
            onClose={onClose}
            onComplete={onComplete}
            onPlay={onPlay}
          />
        )}
      </div>
    </div>
  );
}
