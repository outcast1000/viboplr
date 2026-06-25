import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { Track } from "../../types";
import type { InteractiveSearchResult, DownloadResolveResult, DownloadQualityOption } from "../../types/plugin";
import { formatDuration, formatFileSize } from "../../utils";
import type { AppStore } from "../../store";
import { IconPlay, IconFolder } from "../Icons";
import type { DownloadTrack, UpgradePreviewInfo, DownloadResult, ExistingAction, ResolveState, BatchDownloadTrackState, BatchConflict, ConflictCheck } from "./types";
import { PATH_PATTERNS, previewPattern, buildDestPath } from "./pathUtils";

type BatchStep = "configure" | "resolve" | "review" | "downloading" | "done";

export function MultiTrackDownload({
  tracks,
  providerId: _providerId,
  providerName,
  confirmed,
  qualityOptions,
  collections,
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
  qualityOptions?: DownloadQualityOption[] | null;
  collections: { id: number; name: string; path: string }[];
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
    hasProviderQualities ? qualities[0].value : "flac"
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
  const [batchConflict, setBatchConflict] = useState<BatchConflict | null>(null);
  // Inline "already in your library" prompt (confirmed/batch flow only — the
  // resolve→review flow accounts for library matches up front instead).
  const [batchLibraryMatch, setBatchLibraryMatch] = useState<{
    trackIndex: number;
    title: string;
    existingFormat: string | null;
    existingSize: number | null;
  } | null>(null);
  const libraryResolveRef = useRef<((decision: "download" | "skip") => void) | null>(null);
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
            // Already-in-library prompt. Only the confirmed/batch flow needs this
            // inline check — the resolve→review flow already surfaces library
            // matches up front (so `existingAction` is set there). Done before
            // resolving the stream so a "skip" doesn't waste a fetch.
            if (confirmed) {
              let libMatch: Track | null = null;
              try {
                libMatch = await invoke<Track | null>("find_track_by_metadata", {
                  title: t.title,
                  artistName: t.artistName ?? null,
                  albumName: t.albumTitle ?? null,
                });
              } catch { /* treat as not in library */ }
              if (libMatch && !cancelledRef.current) {
                setBatchLibraryMatch({
                  trackIndex: i,
                  title: t.title,
                  existingFormat: libMatch.format ?? null,
                  existingSize: libMatch.file_size ?? null,
                });
                const decision = await new Promise<"download" | "skip">((resolve) => {
                  libraryResolveRef.current = resolve;
                });
                setBatchLibraryMatch(null);
                libraryResolveRef.current = null;
                if (decision === "skip") {
                  setDownloadStates(prev => prev.map(s =>
                    s.index === i ? { ...s, status: "skipped" } : s
                  ));
                  continue;
                }
              }
            }

            // Resolve the stream URL + metadata
            const resolved = await onResolveRef.current(t.matchId!, quality);
            const streamUrl = resolved.url;

            // Merge metadata
            const title = resolved.metadata?.title || t.title;
            const artistName = resolved.metadata?.artist || t.artistName;
            const albumTitle = resolved.metadata?.album || t.albumTitle;
            const trackNumber = resolved.metadata?.trackNumber ?? t.trackNumber;
            const coverUrl = resolved.metadata?.coverUrl || t.coverUrl;

            // A concrete resolver-provided extension overrides the batch default
            // so the saved file matches the real container (e.g. original files).
            const trackExt = resolved.ext && resolved.ext !== "auto" ? resolved.ext : ext;

            // Build destination path
            const dp = buildDestPath(
              basePath,
              pathPattern,
              title,
              artistName ?? "Unknown",
              albumTitle ?? "Unknown",
              trackNumber,
              trackExt
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
                await invoke("cancel_track_upgrade", { newPath: info.new_path }).catch(console.error);
                setDownloadStates(prev => prev.map(s =>
                  s.index === i ? { ...s, status: "skipped" } : s
                ));
              }
              continue;
            }

            // File-conflict prompt: stat the exact path we're about to write
            // (built from the user's layout pattern) and ask before clobbering.
            let overwrite = false;
            try {
              const conflict = await invoke<ConflictCheck>("check_path_conflict", { destPath: dp });
              if (conflict.has_conflict && !cancelledRef.current) {
                const dotIdx = dp.lastIndexOf(".");
                const altPath = dotIdx > 0 ? `${dp.substring(0, dotIdx)} (2)${dp.substring(dotIdx)}` : `${dp} (2)`;
                setBatchConflict({
                  trackIndex: i,
                  destPath: dp,
                  existingSize: conflict.existing_size,
                  existingFormat: conflict.existing_format,
                  altPath,
                });
                const decision = await new Promise<"replace" | "keep_both" | "skip">((resolve) => {
                  conflictResolveRef.current = resolve;
                });
                setBatchConflict(null);
                conflictResolveRef.current = null;
                if (decision === "skip") {
                  setDownloadStates(prev => prev.map(s =>
                    s.index === i ? { ...s, status: "skipped" } : s
                  ));
                  continue;
                } else if (decision === "replace") {
                  overwrite = true;
                } else {
                  finalPath = altPath;
                }
              }
            } catch {
              // Conflict check failed — fall through and let download_to_path decide.
            }

            // Normal download
            const result = await invoke<DownloadResult>("download_to_path", {
              streamUrl,
              destPath: finalPath,
              format: quality,
              overwrite,
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
              {collections.map(c => (
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

          {/* Inline "already in library" UI */}
          {batchLibraryMatch && (
            <div className="dl-conflict">
              <div className="dl-conflict-filename">
                &ldquo;{batchLibraryMatch.title}&rdquo; is already in your library
              </div>
              <div className="dl-conflict-size">
                Existing: {batchLibraryMatch.existingFormat?.toUpperCase() ?? "Unknown"}
                {batchLibraryMatch.existingSize != null ? `, ${formatFileSize(batchLibraryMatch.existingSize)}` : ""}
              </div>
              <div className="dl-actions" style={{ marginTop: "12px", justifyContent: "center" }}>
                <button onClick={() => libraryResolveRef.current?.("skip")}>Skip</button>
                <button className="dl-btn-primary" onClick={() => libraryResolveRef.current?.("download")}>Download anyway</button>
              </div>
            </div>
          )}

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
