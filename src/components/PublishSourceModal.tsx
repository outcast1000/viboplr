import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { subscribe, combineUnlisten } from "../utils/tauriEvents";

interface ExportResult {
  dest: string;
  manifestUrl: string;
  deepLink: string;
  exported: number;
  skipped: string[];
}

/** Row shape of `list_publish_servers` (tokens are never included). */
interface PublishServerEntry {
  id: number;
  name: string;
  url: string;
  artist_slug: string;
  created_at: number;
}

/** `add_publish_server` result (validated against the live server via whoami). */
interface AddPublishServerResult {
  id: number;
  slug: string;
  displayName: string;
}

interface PublishServerProgress {
  current: number; // 1-based
  total: number;
  title: string;
}

interface PublishOutcome {
  title: string;
  /** "created" | "replaced" | "duplicate" | "rejected" | "aborted" */
  status: string;
  reason?: string | null;
}

interface PublishServerComplete {
  outcomes: PublishOutcome[];
  skipped: string[];
  publicUrl: string;
  manifestUrl: string;
  deepLink: string;
  committedCreated: number;
  committedReplaced: number;
  abortedReason?: string | null;
}

type Destination = "folder" | "server";

const PROBLEM_STATUSES = new Set(["rejected", "aborted", "duplicate"]);

interface PublishSourceModalProps {
  /** One of trackIds / collectionId identifies what to publish. */
  trackIds?: number[];
  collectionId?: number;
  defaultName?: string;
  /** Approximate number of tracks (for display only). */
  trackCount?: number;
  onClose: () => void;
}

export function PublishSourceModal({ trackIds, collectionId, defaultName, trackCount, onClose }: PublishSourceModalProps) {
  const [dest, setDest] = useState<Destination>("folder");

  // --- Folder (static bundle) destination — the original flow, unchanged ---
  const [name, setName] = useState(defaultName ?? "");
  const [baseUrl, setBaseUrl] = useState("");
  const [destDir, setDestDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);

  // --- "My server" destination ---
  const [servers, setServers] = useState<PublishServerEntry[] | null>(null); // null = not loaded yet
  const [selectedServerId, setSelectedServerId] = useState<number | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [srvName, setSrvName] = useState("");
  const [srvUrl, setSrvUrl] = useState("");
  const [srvToken, setSrvToken] = useState("");
  const [srvBusy, setSrvBusy] = useState(false);
  const [srvError, setSrvError] = useState<string | null>(null);
  const [connectedHint, setConnectedHint] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [progress, setProgress] = useState<PublishServerProgress | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [serverResult, setServerResult] = useState<PublishServerComplete | null>(null);
  const [copied, setCopied] = useState(false);

  // Subscribe to the publish events for the whole modal lifetime, so listeners
  // are registered before any `publish_to_server` invoke. `subscribe` handles
  // the async listen/unlisten race and logs failures with console.error.
  useEffect(
    () =>
      combineUnlisten(
        subscribe<PublishServerProgress>("publish-server-progress", (e) => {
          setProgress(e.payload);
        }),
        subscribe<PublishServerComplete>("publish-server-complete", (e) => {
          setPublishing(false);
          setProgress(null);
          setServerResult(e.payload);
        }),
        subscribe<{ message: string }>("publish-server-error", (e) => {
          console.error("Failed to publish to server:", e.payload.message);
          setPublishing(false);
          setProgress(null);
          setServerError(e.payload.message === "cancelled" ? "Publish cancelled." : e.payload.message);
        }),
      ),
    [],
  );

  // Load saved servers when the server destination is first selected.
  useEffect(() => {
    if (dest !== "server" || servers !== null) return;
    let stale = false;
    invoke<PublishServerEntry[]>("list_publish_servers")
      .then((list) => {
        if (stale) return;
        setServers(list);
        if (list.length > 0) setSelectedServerId((cur) => cur ?? list[0].id);
        else setShowAddForm(true); // empty state: show the add form directly
      })
      .catch((e) => {
        console.error("Failed to list publish servers:", e);
        if (stale) return;
        setServers([]);
        setShowAddForm(true);
        setServerError(String(e));
      });
    return () => {
      stale = true;
    };
  }, [dest, servers]);

  async function pickFolder() {
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked === "string") setDestDir(picked);
    } catch (e) {
      console.error("Failed to pick folder:", e);
    }
  }

  async function publish() {
    if (!name.trim() || !baseUrl.trim() || !destDir) return;
    setBusy(true);
    setError(null);
    try {
      const res = await invoke<ExportResult>("export_music_source", {
        destDir,
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        trackIds: collectionId != null ? null : trackIds,
        collectionId: collectionId ?? null,
      });
      setResult(res);
    } catch (e) {
      console.error("Failed to publish music source:", e);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function addServer() {
    if (!srvName.trim() || !srvUrl.trim() || !srvToken.trim() || srvBusy) return;
    setSrvBusy(true);
    setSrvError(null);
    try {
      const res = await invoke<AddPublishServerResult>("add_publish_server", {
        name: srvName.trim(),
        url: srvUrl.trim(),
        token: srvToken.trim(),
      });
      const list = await invoke<PublishServerEntry[]>("list_publish_servers");
      setServers(list);
      setSelectedServerId(res.id);
      setConnectedHint(`Connected as ${res.displayName} (/${res.slug})`);
      setShowAddForm(false);
      setSrvName("");
      setSrvUrl("");
      setSrvToken("");
    } catch (e) {
      console.error("Failed to add publish server:", e);
      setSrvError(String(e));
    } finally {
      setSrvBusy(false);
    }
  }

  async function removeServer() {
    if (selectedServerId == null) return;
    try {
      await invoke("remove_publish_server", { id: selectedServerId });
      const list = await invoke<PublishServerEntry[]>("list_publish_servers");
      setServers(list);
      setSelectedServerId(list.length > 0 ? list[0].id : null);
      setConnectedHint(null);
      if (list.length === 0) setShowAddForm(true);
    } catch (e) {
      console.error("Failed to remove publish server:", e);
      setServerError(String(e));
    }
  }

  async function publishToServer() {
    if (selectedServerId == null || publishing) return;
    setPublishing(true);
    setServerError(null);
    setProgress(null);
    try {
      await invoke("publish_to_server", {
        serverId: selectedServerId,
        trackIds: collectionId != null ? null : (trackIds ?? null),
        collectionId: collectionId ?? null,
      });
      // Returns immediately; progress/completion arrive via events.
    } catch (e) {
      console.error("Failed to start publish to server:", e);
      setServerError(String(e));
      setPublishing(false);
    }
  }

  function cancelPublish() {
    invoke("cancel_publish_to_server").catch((e) => console.error("Failed to cancel publish:", e));
  }

  function handleClose() {
    if (publishing) {
      invoke("cancel_publish_to_server").catch((e) => console.error("Failed to cancel publish on close:", e));
    }
    onClose();
  }

  function copyShareLink(link: string) {
    navigator.clipboard
      .writeText(link)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch((e) => console.error("Failed to copy share link:", e));
  }

  const canPublish = name.trim().length > 0 && baseUrl.trim().length > 0 && !!destDir && !busy;
  const canAddServer = srvName.trim().length > 0 && srvUrl.trim().length > 0 && srvToken.trim().length > 0 && !srvBusy;
  const selectedServer = servers?.find((s) => s.id === selectedServerId) ?? null;
  const serverPublishLabel =
    collectionId != null
      ? "Publish collection"
      : trackCount != null
        ? `Publish ${trackCount} track${trackCount === 1 ? "" : "s"}`
        : "Publish tracks";

  const problemOutcomes = serverResult?.outcomes.filter((o) => PROBLEM_STATUSES.has(o.status)) ?? [];
  const issueCount = problemOutcomes.length + (serverResult?.skipped.length ?? 0);

  const labelStyle = { display: "block", fontSize: "var(--fs-xs)", color: "var(--text-secondary)", marginBottom: 4 } as const;

  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
        {result ? (
          <>
            <div className="ds-modal-title">Music source ready</div>
            <p style={{ fontSize: "var(--fs-sm)", color: "var(--text-secondary)", margin: "8px 0 12px" }}>
              Bundled <strong>{result.exported}</strong> track{result.exported === 1 ? "" : "s"}
              {result.skipped.length > 0 && <> · skipped {result.skipped.length} (remote or missing)</>}.
            </p>

            <label style={labelStyle}>Manifest URL (listeners add this)</label>
            <p><code style={{ fontSize: "var(--fs-xs)", wordBreak: "break-all" }}>{result.manifestUrl}</code></p>

            <label style={{ ...labelStyle, margin: "12px 0 4px" }}>Host on GitHub Pages — run inside the folder:</label>
            <p><code style={{ fontSize: "var(--fs-xs)", wordBreak: "break-all" }}>gh repo create my-music --public --source=. --remote=origin --push</code></p>
            <p style={{ fontSize: "var(--fs-2xs)", color: "var(--text-tertiary)", margin: "4px 0 0" }}>
              Then enable Pages (Settings → Pages → branch <code>main</code> / root). See <code>PUBLISH.md</code> in the folder for details. Or upload the folder to any web server.
            </p>

            <div className="ds-modal-actions" style={{ flexWrap: "wrap", gap: 8 }}>
              <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={() => invoke("open_folder", { folderPath: result.dest }).catch(console.error)}>Reveal folder</button>
              <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={() => openUrl("https://github.com/new").catch(console.error)}>Open GitHub</button>
              <button className="ds-btn ds-btn--primary ds-btn--sm" onClick={handleClose}>Done</button>
            </div>
          </>
        ) : serverResult ? (
          <>
            <div className="ds-modal-title">Published to your server</div>
            <p style={{ fontSize: "var(--fs-sm)", color: "var(--text-secondary)", margin: "8px 0 12px" }}>
              {serverResult.committedCreated} new · {serverResult.committedReplaced} replaced
              {issueCount > 0 && <> · {issueCount} skipped/rejected</>}
            </p>

            {serverResult.abortedReason && (
              <p style={{ fontSize: "var(--fs-xs)", color: "var(--warning)", margin: "0 0 10px" }}>
                Batch aborted: {serverResult.abortedReason} — nothing was committed.
              </p>
            )}

            {issueCount > 0 && (
              <div style={{ maxHeight: 140, overflowY: "auto", margin: "0 0 12px" }}>
                {problemOutcomes.map((o, i) => (
                  <p key={`o-${i}`} style={{ fontSize: "var(--fs-2xs)", color: "var(--text-tertiary)", margin: "2px 0" }}>
                    <span style={{ color: "var(--text-secondary)" }}>{o.title}</span> — {o.status}
                    {o.reason ? `: ${o.reason}` : ""}
                  </p>
                ))}
                {serverResult.skipped.map((t, i) => (
                  <p key={`s-${i}`} style={{ fontSize: "var(--fs-2xs)", color: "var(--text-tertiary)", margin: "2px 0" }}>
                    <span style={{ color: "var(--text-secondary)" }}>{t}</span> — skipped: not a local file
                  </p>
                ))}
              </div>
            )}

            <label style={labelStyle}>Your public page</label>
            <p style={{ margin: "0 0 12px" }}>
              <a
                href={serverResult.publicUrl}
                onClick={(e) => {
                  e.preventDefault();
                  openUrl(serverResult.publicUrl).catch((err) => console.error("Failed to open public URL:", err));
                }}
                style={{ fontSize: "var(--fs-xs)", color: "var(--accent)", wordBreak: "break-all" }}
              >
                {serverResult.publicUrl}
              </a>
            </p>

            <label style={labelStyle}>Manifest URL (listeners add this)</label>
            <p style={{ margin: 0 }}><code style={{ fontSize: "var(--fs-xs)", wordBreak: "break-all" }}>{serverResult.manifestUrl}</code></p>

            <div className="ds-modal-actions" style={{ flexWrap: "wrap", gap: 8 }}>
              <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={() => copyShareLink(serverResult.deepLink)}>
                {copied ? "Copied" : "Copy share link"}
              </button>
              <button className="ds-btn ds-btn--primary ds-btn--sm" onClick={handleClose}>Done</button>
            </div>
          </>
        ) : (
          <>
            <div className="ds-modal-title">Publish as music source</div>

            <div className="ds-tabs ds-tabs--compact" style={{ margin: "10px 0 14px" }}>
              <button
                className={`ds-tab${dest === "folder" ? " active" : ""}`}
                onClick={() => setDest("folder")}
                disabled={busy || publishing}
              >
                Folder (static bundle)
              </button>
              <button
                className={`ds-tab${dest === "server" ? " active" : ""}`}
                onClick={() => setDest("server")}
                disabled={busy || publishing}
              >
                My server
              </button>
            </div>

            {dest === "folder" ? (
              <>
                <p style={{ fontSize: "var(--fs-sm)", color: "var(--text-secondary)", margin: "8px 0 16px" }}>
                  Bundle {trackCount != null ? `${trackCount} track${trackCount === 1 ? "" : "s"}` : "these tracks"} into a
                  folder (<code>index.html</code> + <code>manifest.json</code> + <code>tracks/</code>) you can host on a web
                  server or GitHub. Only local files are included.
                </p>

                <label style={labelStyle}>Source name</label>
                <input className="ds-input" value={name} placeholder="e.g. My Mix" onChange={(e) => setName(e.target.value)} style={{ marginBottom: 12 }} />

                <label style={labelStyle}>Base URL (where you'll host it)</label>
                <input className="ds-input" value={baseUrl} placeholder="https://you.github.io/my-music/" onChange={(e) => setBaseUrl(e.target.value)} />
                <p style={{ fontSize: "var(--fs-2xs)", color: "var(--text-tertiary)", margin: "4px 0 12px" }}>
                  This is where you'll host the folder — the shareable manifest link is built from it. Track refs inside the
                  manifest stay relative, so you can re-host it anywhere without rebuilding. For GitHub Pages use{" "}
                  <code>https://&lt;user&gt;.github.io/&lt;repo&gt;/</code> and create the repo with that name.
                </p>

                <label style={labelStyle}>Output folder</label>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={pickFolder}>Choose folder…</button>
                  <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-tertiary)", wordBreak: "break-all" }}>{destDir ?? "No folder chosen"}</span>
                </div>

                <p style={{ fontSize: "var(--fs-2xs)", color: "var(--text-tertiary)", margin: "14px 0 0" }}>
                  ⚠ Only publish audio you have the right to share — hosting it publicly distributes it.
                </p>

                {error && <p style={{ fontSize: "var(--fs-xs)", color: "var(--error)", margin: "10px 0 0" }}>{error}</p>}

                <div className="ds-modal-actions">
                  <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={handleClose} disabled={busy}>Cancel</button>
                  <button className="ds-btn ds-btn--primary ds-btn--sm" onClick={publish} disabled={!canPublish}>
                    {busy ? "Publishing…" : "Publish"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p style={{ fontSize: "var(--fs-sm)", color: "var(--text-secondary)", margin: "8px 0 16px" }}>
                  Push {trackCount != null ? `${trackCount} track${trackCount === 1 ? "" : "s"}` : "these tracks"} to your own
                  music server. Only local files are uploaded.
                </p>

                {servers === null ? (
                  <p style={{ fontSize: "var(--fs-xs)", color: "var(--text-tertiary)", margin: "0 0 12px" }}>Loading servers…</p>
                ) : (
                  <>
                    {servers.length > 0 && (
                      <>
                        <label style={labelStyle}>Server</label>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                          <select
                            className="ds-select"
                            value={selectedServerId ?? ""}
                            onChange={(e) => {
                              setSelectedServerId(Number(e.target.value));
                              setConnectedHint(null);
                            }}
                            disabled={publishing}
                            style={{ flex: 1, minWidth: 0 }}
                          >
                            {servers.map((s) => (
                              <option key={s.id} value={s.id}>{s.name} — {s.url}</option>
                            ))}
                          </select>
                          <button className="ds-btn ds-btn--ghost ds-btn--sm" onClick={removeServer} disabled={publishing || selectedServerId == null}>
                            Remove
                          </button>
                        </div>
                        {connectedHint && (
                          <p style={{ fontSize: "var(--fs-2xs)", color: "var(--success)", margin: "0 0 8px" }}>{connectedHint}</p>
                        )}
                        {!showAddForm && (
                          <button className="ds-btn ds-btn--ghost ds-btn--sm" onClick={() => setShowAddForm(true)} disabled={publishing} style={{ marginBottom: 8 }}>
                            + Add server
                          </button>
                        )}
                      </>
                    )}

                    {showAddForm && (
                      <>
                        {servers.length === 0 && (
                          <p style={{ fontSize: "var(--fs-xs)", color: "var(--text-tertiary)", margin: "0 0 10px" }}>
                            No servers saved yet — connect your server with an API token:
                          </p>
                        )}
                        <label style={labelStyle}>Name</label>
                        <input className="ds-input" value={srvName} placeholder="My server" onChange={(e) => setSrvName(e.target.value)} style={{ marginBottom: 10 }} />

                        <label style={labelStyle}>Server URL</label>
                        <input className="ds-input" value={srvUrl} placeholder="https://music.example.com" onChange={(e) => setSrvUrl(e.target.value)} style={{ marginBottom: 10 }} />

                        <label style={labelStyle}>API token</label>
                        <input className="ds-input" type="password" value={srvToken} placeholder="bst_…" onChange={(e) => setSrvToken(e.target.value)} style={{ marginBottom: 10 }} />

                        {srvError && <p style={{ fontSize: "var(--fs-xs)", color: "var(--error)", margin: "0 0 10px" }}>{srvError}</p>}

                        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                          <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={addServer} disabled={!canAddServer}>
                            {srvBusy ? "Connecting…" : "Save"}
                          </button>
                          {servers.length > 0 && (
                            <button className="ds-btn ds-btn--ghost ds-btn--sm" onClick={() => { setShowAddForm(false); setSrvError(null); }} disabled={srvBusy}>
                              Cancel
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </>
                )}

                {publishing && (
                  <div style={{ margin: "10px 0 0" }}>
                    <p style={{ fontSize: "var(--fs-xs)", color: "var(--text-secondary)", margin: 0 }}>
                      {progress ? `Uploading ${progress.current}/${progress.total} — ${progress.title}` : "Starting upload…"}
                    </p>
                    {progress && (
                      <div style={{ height: 4, borderRadius: 2, background: "var(--bg-tertiary)", overflow: "hidden", marginTop: 6 }}>
                        <div
                          style={{
                            height: "100%",
                            width: `${Math.min(100, (progress.current / Math.max(1, progress.total)) * 100)}%`,
                            background: "var(--accent)",
                            transition: "width 0.2s",
                          }}
                        />
                      </div>
                    )}
                  </div>
                )}

                {serverError && <p style={{ fontSize: "var(--fs-xs)", color: "var(--error)", margin: "10px 0 0" }}>{serverError}</p>}

                <div className="ds-modal-actions">
                  {publishing ? (
                    <>
                      <button className="ds-btn ds-btn--ghost ds-btn--sm" onClick={cancelPublish}>Cancel publish</button>
                      <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={handleClose}>Close</button>
                    </>
                  ) : (
                    <>
                      <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={handleClose}>Cancel</button>
                      <button
                        className="ds-btn ds-btn--primary ds-btn--sm"
                        onClick={publishToServer}
                        disabled={selectedServerId == null || selectedServer == null}
                      >
                        {serverPublishLabel}
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
