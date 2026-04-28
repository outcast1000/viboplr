import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { InteractiveSearchResult, DownloadResolveResult } from "../types/plugin";
import type { AppStore } from "../store";
import "./InteractiveDownloadModal.css";

export interface BatchDownloadTrack {
  title: string;
  artistName?: string | null;
  albumTitle?: string | null;
  uri?: string | null;
  durationSecs?: number | null;
}

interface BatchDownloadModalProps {
  tracks: BatchDownloadTrack[];
  providerId: string;
  providerName: string;
  confirmed?: boolean;
  collections: { id: number; name: string; path: string }[];
  downloadsCollectionId?: number | null;
  store: AppStore;
  lastDest: string | null;
  onSearch: (query: string, limit: number) => Promise<InteractiveSearchResult[]>;
  onResolve: (matchId: string, format: string) => Promise<DownloadResolveResult>;
  onClose: () => void;
  onComplete: (message: string) => void;
}

type Step = "configure" | "resolve" | "review" | "downloading" | "done";

const PATH_PATTERNS = [
  { value: "[artist]/[album]/[track_number] - [title]", label: "Artist / Album / 01 - Title" },
  { value: "[artist] - [album]/[track_number] - [title]", label: "Artist - Album / 01 - Title" },
  { value: "[artist]/[album]/[artist] - [track_number] - [title]", label: "Artist / Album / Artist - 01 - Title" },
  { value: "[artist] - [album] - [track_number] - [title]", label: "Artist - Album - 01 - Title (flat)" },
];

function previewPattern(pattern: string, artist: string, album: string, ext: string): string {
  return pattern
    .replace(/\[artist\]/g, artist || "Artist")
    .replace(/\[album\]/g, album || "Album")
    .replace(/\[track_number\]/g, "01")
    .replace(/\[title\]/g, "Track Name")
    + "." + ext;
}

export function BatchDownloadModal({
  tracks,
  providerName,
  confirmed,
  collections,
  downloadsCollectionId,
  store,
  lastDest,
  onClose,
}: BatchDownloadModalProps) {
  const [step, setStep] = useState<Step>("configure");
  const [quality, setQuality] = useState<"flac" | "aac">("flac");
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

  // Derive a representative artist/album from the first track for the preview
  const sampleArtist = tracks[0]?.artistName ?? "Artist";
  const sampleAlbum = tracks[0]?.albumTitle ?? "Album";
  const ext = quality === "flac" ? "flac" : "m4a";
  const preview = previewPattern(pathPattern, sampleArtist, sampleAlbum, ext);

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

  return (
    <div className="ds-modal-overlay" onClick={onClose}>
      <div className="ds-modal tidal-dl-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="ds-modal-title">
          Download {tracks.length} tracks from {providerName}
        </h2>

        {tracks.length === 0 && (
          <div className="tidal-dl-error">No tracks to download</div>
        )}

        {step === "configure" && tracks.length > 0 && (
          <>
            <div className="tidal-dl-config-row">
              <label>Quality</label>
              <select value={quality} onChange={(e) => setQuality(e.target.value as "flac" | "aac")}>
                <option value="flac">FLAC (Lossless)</option>
                <option value="aac">AAC (320kbps)</option>
              </select>
            </div>

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
              <div className="tidal-dl-config-row">
                <label />
                <span className="tidal-dl-dest-display">{destPath}</span>
              </div>
            )}

            <div className="tidal-dl-config-row">
              <label>File layout</label>
              <select value={pathPattern} onChange={(e) => setPathPattern(e.target.value)}>
                {PATH_PATTERNS.map(p => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>

            <div className="tidal-dl-config-row">
              <label />
              <span className="tidal-dl-dest-display" style={{ opacity: 0.7 }}>{preview}</span>
            </div>

            <div className="tidal-dl-actions">
              <button onClick={onClose}>Cancel</button>
              <button className="tidal-dl-btn-primary" onClick={handleStart}>
                Start Download
              </button>
            </div>
          </>
        )}

        {step === "resolve" && <p>Resolve step placeholder</p>}
        {step === "review" && <p>Review step placeholder</p>}
        {step === "downloading" && <p>Downloading step placeholder</p>}
        {step === "done" && <p>Done step placeholder</p>}
      </div>
    </div>
  );
}
