import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { TidalSearchTrack } from "../types";
import { tidalCoverUrl, formatDuration } from "../utils";

export type DownloadModalRequest =
  | { kind: "track"; tidalTrackId: string; title: string; artistName: string; coverId: string | null; durationSecs: number | null }
  | { kind: "album"; albumId: string; title: string; artistName: string; coverId: string | null; trackCount: number }
  | { kind: "tracks"; tracks: TidalSearchTrack[] };

interface TrackDownloadState {
  id: number;
  title: string;
  artistName: string;
  status: "queued" | "downloading" | "complete" | "error";
  progressPct: number;
  error?: string;
  destPath?: string;
}

type Phase = "confirm" | "downloading" | "done";
type DestChoice = { kind: "collection"; id: number; path: string } | { kind: "custom"; path: string };

interface TidalDownloadModalProps {
  request: DownloadModalRequest;
  downloadFormat: string;
  localCollections: { id: number; name: string; path: string }[];
  onClose: () => void;
}

export function TidalDownloadModal({ request, downloadFormat: initialFormat, localCollections, onClose }: TidalDownloadModalProps) {
  const [phase, setPhase] = useState<Phase>("confirm");
  const [format, setFormat] = useState(initialFormat);
  const [dest, setDest] = useState<DestChoice>(
    localCollections[0] ? { kind: "collection", id: localCollections[0].id, path: localCollections[0].path } : { kind: "custom", path: "" }
  );
  const [trackStates, setTrackStates] = useState<TrackDownloadState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const trackedIdsRef = useRef<Set<number>>(new Set());

  const destPath = dest.kind === "collection" ? dest.path : dest.path;

  // Listen for download events and update track states
  useEffect(() => {
    if (phase !== "downloading") return;

    const unlistenProgress = listen<{ id: number; track_title: string; artist_name: string; status: string; progress_pct: number }>(
      "download-progress",
      (event) => {
        const { id, status, progress_pct } = event.payload;
        if (!trackedIdsRef.current.has(id)) return;
        setTrackStates(prev => prev.map(t =>
          t.id === id
            ? { ...t, status: status === "writing_tags" ? "downloading" : "downloading", progressPct: progress_pct }
            : t
        ));
      }
    );

    const unlistenComplete = listen<{ id: number; trackTitle: string; destPath: string }>(
      "download-complete",
      (event) => {
        const { id, destPath } = event.payload;
        if (!trackedIdsRef.current.has(id)) return;
        setTrackStates(prev => {
          const next = prev.map(t =>
            t.id === id ? { ...t, status: "complete" as const, progressPct: 100, destPath } : t
          );
          if (next.every(t => t.status === "complete" || t.status === "error")) {
            setTimeout(() => setPhase("done"), 300);
          }
          return next;
        });
      }
    );

    const unlistenError = listen<{ id: number; trackTitle: string; error: string }>(
      "download-error",
      (event) => {
        const { id, error } = event.payload;
        if (!trackedIdsRef.current.has(id)) return;
        setTrackStates(prev => {
          const next = prev.map(t =>
            t.id === id ? { ...t, status: "error" as const, error } : t
          );
          if (next.every(t => t.status === "complete" || t.status === "error")) {
            setTimeout(() => setPhase("done"), 300);
          }
          return next;
        });
      }
    );

    return () => {
      unlistenProgress.then(f => f());
      unlistenComplete.then(f => f());
      unlistenError.then(f => f());
    };
  }, [phase]);

  async function handlePickFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      setDest({ kind: "custom", path: selected });
    }
  }

  function handleDestChange(value: string) {
    if (value === "__custom__") {
      handlePickFolder();
    } else {
      const c = localCollections.find(c => c.id === Number(value));
      if (c) setDest({ kind: "collection", id: c.id, path: c.path });
    }
  }

  async function handleStartDownload() {
    if (!destPath) {
      setError("Please select a download destination.");
      return;
    }
    setError(null);
    try {
      const collectionId = dest.kind === "collection" ? dest.id : null;
      const customPath = dest.kind === "custom" ? dest.path : null;

      if (request.kind === "track") {
        const id = await invoke<number>("tidal_save_track", {
          tidalTrackId: request.tidalTrackId,
          destCollectionId: collectionId,
          customDestPath: customPath,
          format,
        });
        trackedIdsRef.current = new Set([id]);
        setTrackStates([{
          id,
          title: request.title,
          artistName: request.artistName,
          status: "queued",
          progressPct: 0,
        }]);
      } else if (request.kind === "album") {
        const ids = await invoke<number[]>("download_album", {
          albumId: request.albumId,
          destCollectionId: collectionId,
          customDestPath: customPath,
          format,
        });
        trackedIdsRef.current = new Set(ids);
        setTrackStates(ids.map((id, i) => ({
          id,
          title: `Track ${i + 1}`,
          artistName: request.artistName,
          status: "queued" as const,
          progressPct: 0,
        })));
      } else {
        // Multiple selected tracks
        const ids: number[] = [];
        const states: TrackDownloadState[] = [];
        for (const track of request.tracks) {
          const id = await invoke<number>("tidal_save_track", {
            tidalTrackId: track.tidal_id,
            destCollectionId: collectionId,
            customDestPath: customPath,
            format,
          });
          ids.push(id);
          states.push({
            id,
            title: track.title,
            artistName: track.artist_name ?? "",
            status: "queued",
            progressPct: 0,
          });
        }
        trackedIdsRef.current = new Set(ids);
        setTrackStates(states);
      }
      setPhase("downloading");
    } catch (e) {
      setError(String(e));
    }
  }

  function handleCancelQueued(downloadId: number) {
    invoke<boolean>("cancel_download", { downloadId }).then(cancelled => {
      if (cancelled) {
        setTrackStates(prev => {
          const next = prev.filter(t => t.id !== downloadId);
          trackedIdsRef.current.delete(downloadId);
          if (next.length === 0 || next.every(t => t.status === "complete" || t.status === "error")) {
            setTimeout(() => setPhase("done"), 100);
          }
          return next;
        });
      }
    });
  }

  function handleCancelAll() {
    for (const t of trackStates) {
      if (t.status === "queued") {
        invoke("cancel_download", { downloadId: t.id }).catch(() => {});
      }
    }
    setPhase("done");
  }

  function handleOpenFolder(e: React.MouseEvent) {
    e.stopPropagation();
    if (destPath) {
      invoke("open_folder", { folderPath: destPath }).catch(console.error);
    }
  }

  function handleOpenFile(path: string) {
    invoke("show_in_folder_path", { filePath: path }).catch(console.error);
  }

  const completedCount = trackStates.filter(t => t.status === "complete").length;
  const errorCount = trackStates.filter(t => t.status === "error").length;
  const totalCount = trackStates.length;
  const overallProgress = totalCount > 0
    ? Math.round(trackStates.reduce((sum, t) => sum + (t.status === "complete" ? 100 : t.progressPct), 0) / totalCount)
    : 0;

  // Cover image for the confirm phase
  const coverUrl = request.kind === "tracks"
    ? tidalCoverUrl(request.tracks[0]?.cover_id, 160)
    : tidalCoverUrl(request.coverId, 160);

  // Track list for confirm phase
  const confirmTracks: { title: string; artistName: string; durationSecs: number | null }[] =
    request.kind === "track"
      ? [{ title: request.title, artistName: request.artistName, durationSecs: request.durationSecs }]
      : request.kind === "tracks"
        ? request.tracks.map(t => ({ title: t.title, artistName: t.artist_name ?? "", durationSecs: t.duration_secs }))
        : [];

  const canStart = !!destPath;

  return (
    <div className="tidal-dl-overlay" onClick={onClose}>
      <div className="tidal-dl-modal" onClick={e => e.stopPropagation()}>

        {/* Confirm phase */}
        {phase === "confirm" && (
          <>
            <div className="tidal-dl-header">
              {coverUrl && <img className="tidal-dl-cover" src={coverUrl} alt="" />}
              <div className="tidal-dl-header-info">
                <h3>{request.kind === "tracks" ? `${request.tracks.length} tracks` : request.title}</h3>
                <span className="tidal-dl-header-artist">
                  {request.kind === "tracks" ? "Selected tracks" : request.artistName}
                </span>
                {request.kind === "album" && (
                  <span className="tidal-dl-header-meta">{request.trackCount} tracks</span>
                )}
              </div>
            </div>

            {/* Track list preview */}
            {confirmTracks.length > 0 && (
              <div className="tidal-dl-confirm-tracks">
                {confirmTracks.map((t, i) => (
                  <div key={i} className="tidal-dl-confirm-track">
                    <span className="tidal-dl-confirm-track-num">{i + 1}</span>
                    <span className="tidal-dl-confirm-track-title">{t.title}</span>
                    <span className="tidal-dl-confirm-track-artist">{t.artistName}</span>
                    <span className="tidal-dl-confirm-track-dur">{formatDuration(t.durationSecs)}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="tidal-dl-field">
              <label>Download to</label>
              <select
                value={dest.kind === "collection" ? String(dest.id) : "__custom__"}
                onChange={e => handleDestChange(e.target.value)}
                className="tidal-dl-select"
              >
                {localCollections.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
                <option value="__custom__">Custom folder...</option>
              </select>
              {destPath && <span className="tidal-dl-path">{destPath}</span>}
            </div>

            <div className="tidal-dl-field">
              <label>Format</label>
              <select
                value={format}
                onChange={e => setFormat(e.target.value)}
                className="tidal-dl-select"
              >
                <option value="flac">FLAC (Lossless)</option>
                <option value="aac">M4A (AAC)</option>
              </select>
            </div>

            {error && <div className="tidal-dl-error">{error}</div>}

            <div className="tidal-dl-actions">
              <button className="tidal-dl-btn-secondary" onClick={onClose}>Cancel</button>
              <button
                className="tidal-dl-btn-primary"
                onClick={handleStartDownload}
                disabled={!canStart}
              >
                {"\u2B07"} Download
              </button>
            </div>
          </>
        )}

        {/* Downloading phase */}
        {phase === "downloading" && (
          <>
            <div className="tidal-dl-progress-header">
              <h3>Downloading...</h3>
              <span className="tidal-dl-progress-summary">{completedCount} / {totalCount} complete</span>
            </div>

            <div className="tidal-dl-overall-bar">
              <div className="tidal-dl-overall-fill" style={{ width: `${overallProgress}%` }} />
            </div>

            <div className="tidal-dl-track-list">
              {trackStates.map(t => (
                <div key={t.id} className={`tidal-dl-track tidal-dl-track-${t.status}`}>
                  <div className="tidal-dl-track-icon">
                    {t.status === "complete" && <span className="tidal-dl-icon-ok">{"\u2713"}</span>}
                    {t.status === "error" && <span className="tidal-dl-icon-err">{"\u2717"}</span>}
                    {t.status === "downloading" && <span className="tidal-dl-icon-active" />}
                    {t.status === "queued" && <span className="tidal-dl-icon-queued" />}
                  </div>
                  <div className="tidal-dl-track-info">
                    <span className="tidal-dl-track-title">{t.title}</span>
                    {t.status === "downloading" && (
                      <div className="tidal-dl-track-bar">
                        <div className="tidal-dl-track-fill" style={{ width: `${t.progressPct}%` }} />
                      </div>
                    )}
                    {t.status === "error" && t.error && (
                      <span className="tidal-dl-track-error">{t.error}</span>
                    )}
                  </div>
                  {t.status === "queued" && (
                    <button
                      className="tidal-dl-track-cancel"
                      onClick={() => handleCancelQueued(t.id)}
                      title="Cancel"
                    >
                      {"\u00D7"}
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="tidal-dl-actions">
              <button className="tidal-dl-btn-secondary" onClick={handleCancelAll}>Cancel remaining</button>
            </div>
          </>
        )}

        {/* Done phase */}
        {phase === "done" && (
          <>
            <div className="tidal-dl-done-header">
              <h3>
                {errorCount === 0 ? "Download complete" : errorCount === totalCount ? "Download failed" : "Download finished"}
              </h3>
              <span className="tidal-dl-done-summary">
                {completedCount > 0 && <>{completedCount} downloaded</>}
                {completedCount > 0 && errorCount > 0 && ", "}
                {errorCount > 0 && <span className="tidal-dl-done-errors">{errorCount} failed</span>}
              </span>
            </div>

            <div className="tidal-dl-track-list">
              {trackStates.map(t => (
                <div key={t.id} className={`tidal-dl-track tidal-dl-track-${t.status}`}>
                  <div className="tidal-dl-track-icon">
                    {t.status === "complete" && <span className="tidal-dl-icon-ok">{"\u2713"}</span>}
                    {t.status === "error" && <span className="tidal-dl-icon-err">{"\u2717"}</span>}
                  </div>
                  <div className="tidal-dl-track-info">
                    <span className="tidal-dl-track-title">{t.title}</span>
                    {t.status === "error" && t.error && (
                      <span className="tidal-dl-track-error">{t.error}</span>
                    )}
                    {t.status === "complete" && t.destPath && (
                      <span
                        className="tidal-dl-track-path"
                        onClick={() => handleOpenFile(t.destPath!)}
                        title="Reveal in file manager"
                      >
                        {t.destPath}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {destPath && (
              <div className="tidal-dl-location">
                <span className="tidal-dl-location-path">{destPath}</span>
                <button className="tidal-dl-btn-secondary" onClick={handleOpenFolder}>Open folder</button>
              </div>
            )}

            <div className="tidal-dl-actions">
              <button className="tidal-dl-btn-primary" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
