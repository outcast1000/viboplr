import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { safeUnlisten } from "../../utils/tauriEvents";
import { open } from "@tauri-apps/plugin-dialog";
import type { Track } from "../../types";
import type { DownloadQualityOption } from "../../types/plugin";
import { formatDuration, formatFileSize } from "../../utils";
import { defaultQualityValue } from "../../utils/downloadQuality";
import type { DownloadItem } from "../../utils/downloadModalState";
import type { AppStore } from "../../store";
import { IconPlay, IconFolder, IconDownload } from "../Icons";
import type { DownloadResult, BatchDownloadTrackState, BatchConflict, ConflictCheck, DownloadPurpose } from "./types";
import { downloadWording, SOURCE_AS_IS } from "./types";
import { PATH_PATTERNS, previewPattern, buildDestPath } from "./pathUtils";
import { ProviderChip } from "./ProviderChip";
import { QualitySelect } from "./QualitySelect";
import { DestField } from "./DestField";

type BatchStep = "configure" | "downloading" | "done";

const STATUS_GLYPH: Record<BatchDownloadTrackState["status"], { glyph: string; color: string } | null> = {
  queued: { glyph: "·", color: "var(--text-tertiary)" },
  downloading: null, // a spinner
  done: { glyph: "✓", color: "var(--success)" },
  error: { glyph: "✗", color: "var(--error)" },
  skipped: { glyph: "–", color: "var(--text-tertiary)" },
};

/**
 * Download several tracks, each fetched by its own resolve (a plugin's
 * `download-tracks` / `download-album` request — every track names its source).
 * One destination and quality for all, then a sequential run that stops to ask
 * about a song already in the library or a file already on disk.
 */
export function MultiTrackDownload({
  items,
  providerName,
  qualityOptions,
  collections,
  store,
  lastDest,
  onCancelResolve,
  onClose,
  onComplete,
  onPlay,
  purpose,
}: {
  items: DownloadItem[];
  providerName: string;
  qualityOptions?: DownloadQualityOption[] | null;
  collections: { id: number; name: string; path: string }[];
  store: AppStore;
  lastDest: string | null;
  /** Stops the provider's in-flight resolve (its yt-dlp / ffmpeg run). A
   *  resolve can be the whole download, so Cancel must reach it. */
  onCancelResolve?: () => void;
  onClose: () => void;
  onComplete: (message: string) => void;
  onPlay?: (path: string) => void;
  /** See `DownloadPurpose` — only the words change. */
  purpose?: DownloadPurpose;
}) {
  const words = downloadWording(purpose);
  const tracks = items.map((i) => i.track);
  const hasProviderQualities = !!qualityOptions?.length;
  const qualities = hasProviderQualities ? qualityOptions! : SOURCE_AS_IS;
  // Last-resort extension when the resolver reports none: this path never
  // sniffs the bytes, so the container can't be known.
  const nativeFallback: string | null = hasProviderQualities ? null : "bin";

  const [step, setStep] = useState<BatchStep>("configure");
  // An all-video selection defaults to the provider's video option — same rule
  // as the single-track flow; mixed or audio selections default to the first.
  const allVideo = tracks.length > 0 && tracks.every(t => t.isVideo);
  const [quality, setQualityState] = useState<string>(
    hasProviderQualities ? (defaultQualityValue(qualities, allVideo) ?? qualities[0].value) : "original"
  );
  const setQuality = (q: string) => {
    setQualityState(q);
    if (!hasProviderQualities) store.set("lastDownloadQuality", q);
  };

  useEffect(() => {
    if (hasProviderQualities) return;
    store.get<string>("lastDownloadQuality").then(saved => {
      if (saved && qualities.some(q => q.value === saved)) setQualityState(saved);
    }).catch((e) => console.error("Failed to read the last download quality:", e));
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

  const [downloadStates, setDownloadStates] = useState<BatchDownloadTrackState[]>([]);
  const [batchConflict, setBatchConflict] = useState<BatchConflict | null>(null);
  const [batchLibraryMatch, setBatchLibraryMatch] = useState<{
    title: string;
    existingFormat: string | null;
    existingSize: number | null;
  } | null>(null);
  const cancelledRef = useRef(false);
  const libraryResolveRef = useRef<((decision: "download" | "skip") => void) | null>(null);
  const conflictResolveRef = useRef<((decision: "replace" | "keep_both" | "skip") => void) | null>(null);

  // Cancel during the run: the loop awaits inline prompt promises (library
  // match / conflict), so a bare onClose would strand it forever — answer any
  // pending prompt with "skip" so the loop can see cancelledRef and clean up,
  // and abort the in-flight resolve and transfer.
  function cancelDownloads() {
    cancelledRef.current = true;
    libraryResolveRef.current?.("skip");
    conflictResolveRef.current?.("skip");
    onCancelResolve?.();
    invoke("cancel_direct_download").catch(console.error);
    onClose();
  }

  const patchRow = (i: number, patch: Partial<BatchDownloadTrackState> | ((s: BatchDownloadTrackState) => Partial<BatchDownloadTrackState>)) =>
    setDownloadStates(prev => prev.map(s => s.index === i ? { ...s, ...(typeof patch === "function" ? patch(s) : patch) } : s));

  // Download step: one track at a time. Guarded for StrictMode's double effect.
  const downloadGuard = useRef(false);
  useEffect(() => {
    if (step !== "downloading") return;
    if (downloadGuard.current) return;
    downloadGuard.current = true;
    cancelledRef.current = false;

    (async () => {
      store.set("lastDownloadDest", destType === "collection" && destCollectionId != null ? String(destCollectionId) : null);
      const basePath = (destType === "collection"
        ? collections.find(c => c.id === destCollectionId)?.path
        : destPath) ?? "";

      setDownloadStates(tracks.map((t, i) => ({
        index: i,
        title: t.title,
        artist: t.artistName ?? "",
        status: "queued",
        progress: 0,
      })));

      const ext = nativeFallback ?? (quality === "flac" ? "flac" : "m4a");
      const isVideoQuality = qualities.find(q => q.value === quality)?.video === true;

      const unlisten = await listen<number>("direct-download-progress", (event) => {
        setDownloadStates(prev => {
          const downloading = prev.find(s => s.status === "downloading");
          // A provider that already fetched the file (yt-dlp) reported its own
          // progress; the copy into place must not restart the row at 0%.
          if (!downloading || downloading.savingLocal) return prev;
          return prev.map(s => s.index === downloading.index ? { ...s, progress: event.payload } : s);
        });
      });

      try {
        for (let i = 0; i < items.length; i++) {
          if (cancelledRef.current) break;
          const { track: t, resolve } = items[i];
          patchRow(i, { status: "downloading", progress: 0 });

          try {
            // Already in the library? Asked before resolving, so a skip
            // doesn't cost a fetch.
            let libMatch: Track | null = null;
            try {
              libMatch = await invoke<Track | null>("find_track_by_metadata", {
                title: t.title,
                artistName: t.artistName ?? null,
                albumName: t.albumTitle ?? null,
              });
            } catch (e) { console.error("Failed to check the library for a batch track:", e); }
            if (libMatch && !cancelledRef.current) {
              setBatchLibraryMatch({
                title: t.title,
                existingFormat: libMatch.format ?? null,
                existingSize: libMatch.file_size ?? null,
              });
              const decision = await new Promise<"download" | "skip">((r) => { libraryResolveRef.current = r; });
              setBatchLibraryMatch(null);
              libraryResolveRef.current = null;
              if (decision === "skip") {
                patchRow(i, { status: "skipped" });
                continue;
              }
            }

            // A provider that downloads the file itself reports how far it is;
            // show it on this track's row.
            const resolved = await resolve(quality, (p) => {
              if (cancelledRef.current) return;
              patchRow(i, (s) => ({
                progress: typeof p.percent === "number" ? Math.max(0, Math.min(100, Math.round(p.percent))) : s.progress,
                stage: [p.label, p.detail].filter(Boolean).join(" · ") || s.stage,
              }));
            });
            if (!resolved) throw new Error(`${providerName} couldn't find this track to download.`);
            const streamUrl = resolved.url;
            const savingLocal = streamUrl.startsWith("file://");
            patchRow(i, { savingLocal, stage: savingLocal ? "Saving…" : undefined });

            const title = resolved.metadata?.title || t.title;
            const artistName = resolved.metadata?.artist || t.artistName;
            const albumTitle = resolved.metadata?.album || t.albumTitle;
            const trackNumber = resolved.metadata?.trackNumber ?? null;
            const coverUrl = resolved.metadata?.coverUrl ?? null;
            // A concrete resolver extension overrides the batch default so the
            // saved file matches the real container.
            const trackExt = resolved.ext && resolved.ext !== "auto" ? resolved.ext : ext;
            const dp = buildDestPath(basePath, pathPattern, title, artistName ?? "Unknown", albumTitle ?? "Unknown", trackNumber, trackExt);

            // A file already at that path: ask before clobbering it.
            let finalPath = dp;
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
                const decision = await new Promise<"replace" | "keep_both" | "skip">((r) => { conflictResolveRef.current = r; });
                setBatchConflict(null);
                conflictResolveRef.current = null;
                if (decision === "skip") {
                  patchRow(i, { status: "skipped" });
                  continue;
                }
                if (decision === "replace") overwrite = true;
                else finalPath = altPath;
              }
            } catch (e) {
              // Let download_to_path decide.
              console.error("Failed to check a batch download destination:", e);
            }

            const result = await invoke<DownloadResult>("download_to_path", {
              streamUrl,
              destPath: finalPath,
              format: quality,
              overwrite,
              title,
              artistName,
              albumTitle,
              trackNumber,
              coverUrl,
              isVideo: isVideoQuality || (!hasProviderQualities && !!t.isVideo),
            });

            if (destType === "collection" && destCollectionId != null) {
              try {
                await invoke("add_downloaded_track", { path: result.path, collectionId: destCollectionId });
              } catch (e) {
                // The file is saved, just not indexed. Shown on the row.
                console.error("Failed to add a downloaded file to the library:", e);
                patchRow(i, { error: `Saved, but not added to the library: ${e instanceof Error ? e.message : String(e)}` });
              }
            }
            patchRow(i, { status: "done", progress: 100, filePath: result.path });
          } catch (err) {
            console.error("Failed to download track:", t.title, err);
            patchRow(i, { status: "error", error: err instanceof Error ? err.message : String(err) });
          }
        }
      } finally {
        safeUnlisten(unlisten);
      }
      setStep("done");
    })();

    return () => {
      cancelledRef.current = true;
    };
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleBrowseFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      setDestType("path");
      setDestPath(selected);
      setDestCollectionId(null);
    }
  }

  const ext = nativeFallback ?? (quality === "flac" ? "flac" : "m4a");
  const pathPreview = previewPattern(
    pathPattern,
    tracks[0]?.artistName ?? "Artist",
    tracks[0]?.albumTitle ?? "Album",
    tracks[0]?.title ?? "Track Name",
    ext,
  );
  const totalDur = tracks.reduce((s, t) => s + (t.durationSecs ?? 0), 0);
  const finished = downloadStates.filter(t => t.status === "done" || t.status === "error" || t.status === "skipped").length;
  const doneCount = downloadStates.filter(t => t.status === "done").length;
  const errCount = downloadStates.filter(t => t.status === "error").length;
  const skippedCount = downloadStates.filter(t => t.status === "skipped").length;
  const headTitle = step === "downloading" ? words.workingMany : step === "done" ? words.done : words.multiTitle(tracks.length);

  const renderRow = (ds: BatchDownloadTrackState) => {
    const glyph = STATUS_GLYPH[ds.status];
    return (
      <div key={ds.index} className="dl-batch-row">
        <div className="dl-batch-status">
          {glyph ? <span style={{ color: glyph.color }}>{glyph.glyph}</span> : <div className="ds-spinner ds-spinner--sm" />}
        </div>
        <div className="dl-batch-info">
          <div className="dl-batch-title">{ds.title}</div>
          {ds.artist && <div className="dl-batch-match">{ds.artist}</div>}
          {ds.status === "downloading" && ds.stage && <div className="dl-batch-match">{ds.stage}</div>}
          {ds.error && (ds.status === "error" || ds.status === "done") && (
            <div className="dl-batch-match" style={{ color: ds.status === "error" ? "var(--error)" : "var(--warning)" }}>{ds.error}</div>
          )}
        </div>
        {ds.status === "downloading" && <div className="dl-batch-progress">{ds.progress}%</div>}
        {ds.status === "done" && ds.filePath && (
          <div className="dl-batch-action" style={{ display: "flex", gap: "4px" }}>
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
    );
  };

  const overallBar = (pct: number, label: string) => (
    <div className="dl-batch-overall">
      <div className="dl-progress">
        <div className="dl-progress-bar">
          <div className="dl-progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="dl-progress-pct">{label}</span>
      </div>
    </div>
  );

  return (
    <>
      <div className="dl-head">
        <h2>{headTitle}</h2>
        <ProviderChip name={providerName} />
      </div>

      {step === "configure" && (
        <>
          <div className="dl-config-row">
            <label>Quality</label>
            <QualitySelect qualities={qualities} value={quality} onChange={setQuality} />
          </div>

          <div className="dl-config-row">
            <label>Save to</label>
            <DestField
              collections={collections}
              destType={destType}
              destCollectionId={destCollectionId}
              destPath={destPath}
              onPickCollection={(id) => { setDestType("collection"); setDestCollectionId(id); setDestPath(null); }}
              onBrowse={handleBrowseFolder}
            />
          </div>

          <div className="dl-config-row">
            <label>Layout</label>
            <select value={pathPattern} onChange={(e) => setPathPattern(e.target.value)}>
              {PATH_PATTERNS.map(p => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>
          <div className="dl-path-preview">{pathPreview}</div>

          <div className="dl-list-header">{tracks.length} tracks{totalDur ? ` · ${formatDuration(totalDur)}` : ""}</div>
          <div className="dl-batch-list">
            {tracks.map((t, i) => (
              <div key={i} className="dl-batch-row">
                <div className="dl-batch-info">
                  <div className="dl-batch-title">{t.title}</div>
                  {(t.artistName || t.durationSecs) && (
                    <div className="dl-batch-match">
                      {[t.artistName, t.durationSecs ? formatDuration(t.durationSecs) : null].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="dl-actions">
            <button onClick={onClose}>Cancel</button>
            <button className="dl-btn-primary" onClick={() => setStep("downloading")}>
              <IconDownload size={15} />
              {words.startMany(tracks.length)}
            </button>
          </div>
        </>
      )}

      {step === "downloading" && (
        <>
          {overallBar(downloadStates.length > 0 ? finished / downloadStates.length * 100 : 0, `${finished} / ${downloadStates.length}`)}

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
                <button className="dl-btn-primary" onClick={() => libraryResolveRef.current?.("download")}>{words.startAnyway}</button>
              </div>
            </div>
          )}

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

          <div className="dl-batch-list">{downloadStates.map(renderRow)}</div>

          <div className="dl-actions">
            <button onClick={cancelDownloads}>Cancel</button>
          </div>
        </>
      )}

      {step === "done" && (
        <>
          {overallBar(100, `${doneCount} / ${downloadStates.length}`)}
          <div className="dl-batch-list">{downloadStates.map(renderRow)}</div>
          <div className="dl-batch-footer">
            <span>
              {doneCount} downloaded{errCount > 0 ? `, ${errCount} failed` : ""}{skippedCount > 0 ? `, ${skippedCount} skipped` : ""}
            </span>
          </div>
          <div className="dl-actions">
            <button className="dl-btn-primary" onClick={() => {
              onComplete(words.summary(doneCount, downloadStates.length));
              onClose();
            }}>
              Done
            </button>
          </div>
        </>
      )}
    </>
  );
}
