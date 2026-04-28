import { useState, useRef, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { InteractiveSearchResult, DownloadResolveResult } from "../types/plugin";
import type { AppStore } from "../store";
import "./InteractiveDownloadModal.css";

interface ResolveState {
  originalTrack: BatchDownloadTrack;
  status: "pending" | "searching" | "matched" | "not_found";
  match?: InteractiveSearchResult | null;
}

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
  onSearch,
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

  // Resolve step state
  const [resolveStates, setResolveStates] = useState<ResolveState[]>([]);
  const cancelledRef = useRef(false);

  // Review step state
  const [manualSearchIndex, setManualSearchIndex] = useState<number | null>(null);
  const [manualQuery, setManualQuery] = useState("");
  const [manualResults, setManualResults] = useState<InteractiveSearchResult[]>([]);
  const [manualSearching, setManualSearching] = useState(false);

  useEffect(() => {
    if (step !== "resolve") return;
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
          const results = await onSearch(query, 5);
          const match = results.length > 0 ? results[0] : null;

          setResolveStates(prev => prev.map((s, idx) =>
            idx === i ? { ...s, status: match ? "matched" : "not_found", match } : s
          ));
        } catch (err) {
          console.error("Failed to resolve track:", err);
          setResolveStates(prev => prev.map((s, idx) =>
            idx === i ? { ...s, status: "not_found", match: null } : s
          ));
        }

        // 200ms delay between searches (except after the last one)
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
  }, [step, tracks, onSearch]);

  async function handleManualSearch(_index: number) {
    setManualSearching(true);
    try {
      const results = await onSearch(manualQuery, 10);
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

        {step === "resolve" && (
          <>
            <div className="tidal-dl-batch-list">
              {resolveStates.map((rs, i) => (
                <div key={i} className="tidal-dl-batch-row">
                  <div className="tidal-dl-batch-status">
                    {rs.status === "searching" && <div className="ds-spinner ds-spinner--sm" />}
                    {rs.status === "matched" && <span style={{color: "var(--success)"}}>&#10003;</span>}
                    {rs.status === "not_found" && <span style={{color: "var(--error)"}}>&#10007;</span>}
                    {rs.status === "pending" && <span style={{color: "var(--text-tertiary)"}}>&#183;</span>}
                  </div>
                  <div className="tidal-dl-batch-info">
                    <div className="tidal-dl-batch-title">{rs.originalTrack.title}</div>
                    {rs.status === "matched" && rs.match && (
                      <div className="tidal-dl-batch-match">&rarr; {rs.match.title}{rs.match.artistName ? ` — ${rs.match.artistName}` : ""}</div>
                    )}
                    {rs.status === "not_found" && (
                      <div className="tidal-dl-batch-match">No match found</div>
                    )}
                    {rs.status === "searching" && (
                      <div className="tidal-dl-batch-match">Searching...</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="tidal-dl-actions">
              <button onClick={() => { cancelledRef.current = true; onClose(); }}>Cancel</button>
            </div>
          </>
        )}

        {step === "review" && (
          <>
            <div className="tidal-dl-batch-list">
              {resolveStates.map((rs, i) => (
                <div key={i}>
                  <div className="tidal-dl-batch-row">
                    <div className="tidal-dl-batch-status">
                      {rs.status === "matched" && <span style={{color: "var(--success)"}}>&#10003;</span>}
                      {rs.status === "not_found" && <span style={{color: "var(--error)"}}>&#10007;</span>}
                    </div>
                    <div className="tidal-dl-batch-info">
                      <div className="tidal-dl-batch-title">{rs.originalTrack.title}</div>
                      {rs.status === "matched" && rs.match && (
                        <div className="tidal-dl-batch-match">&rarr; {rs.match.title}{rs.match.artistName ? ` — ${rs.match.artistName}` : ""}</div>
                      )}
                      {rs.status === "not_found" && (
                        <div className="tidal-dl-batch-match">No match found</div>
                      )}
                    </div>
                    {rs.status === "not_found" && (
                      <div className="tidal-dl-batch-action">
                        <button className="tidal-dl-btn-small" onClick={() => {
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
                    <div className="tidal-dl-batch-inline-search">
                      <div className="tidal-dl-search-field">
                        <input
                          value={manualQuery}
                          onChange={e => setManualQuery(e.target.value)}
                          onKeyDown={e => { if (e.key === "Enter") handleManualSearch(i); }}
                          placeholder="Search..."
                        />
                        <button onClick={() => handleManualSearch(i)} disabled={manualSearching}>Search</button>
                      </div>
                      {manualSearching && <div className="tidal-dl-loading"><div className="ds-spinner ds-spinner--sm" /></div>}
                      {!manualSearching && manualResults.length > 0 && (
                        <div className="tidal-dl-batch-inline-results">
                          {manualResults.map(r => (
                            <div key={r.id} className="tidal-dl-batch-row" style={{cursor: "pointer"}} onClick={() => handlePickManualMatch(i, r)}>
                              <div className="tidal-dl-batch-info">
                                <div className="tidal-dl-batch-title">{r.title}</div>
                                <div className="tidal-dl-batch-match">{r.artistName}{r.albumTitle ? ` — ${r.albumTitle}` : ""}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {!manualSearching && manualResults.length === 0 && manualQuery && (
                        <div className="tidal-dl-empty" style={{padding: "8px"}}>No results</div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="tidal-dl-batch-footer">
              <span>{resolveStates.filter(s => s.status === "matched").length} matched, {resolveStates.filter(s => s.status === "not_found").length} not found</span>
            </div>

            <div className="tidal-dl-actions">
              <button onClick={onClose}>Cancel</button>
              <button className="tidal-dl-btn-primary" onClick={() => setStep("downloading")}
                disabled={resolveStates.filter(s => s.status === "matched").length === 0}>
                Download {resolveStates.filter(s => s.status === "matched").length} tracks
              </button>
            </div>
          </>
        )}
        {step === "downloading" && <p>Downloading step placeholder</p>}
        {step === "done" && <p>Done step placeholder</p>}
      </div>
    </div>
  );
}
