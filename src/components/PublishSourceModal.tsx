import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

interface ExportResult {
  dest: string;
  manifestUrl: string;
  deepLink: string;
  exported: number;
  skipped: string[];
}

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
  const [name, setName] = useState(defaultName ?? "");
  const [baseUrl, setBaseUrl] = useState("");
  const [destDir, setDestDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);

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

  const canPublish = name.trim().length > 0 && baseUrl.trim().length > 0 && !!destDir && !busy;

  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
        {!result ? (
          <>
            <div className="ds-modal-title">Publish as music source</div>
            <p style={{ fontSize: "var(--fs-sm)", color: "var(--text-secondary)", margin: "8px 0 16px" }}>
              Bundle {trackCount != null ? `${trackCount} track${trackCount === 1 ? "" : "s"}` : "these tracks"} into a
              folder (<code>index.html</code> + <code>manifest.json</code> + <code>tracks/</code>) you can host on a web
              server or GitHub. Only local files are included.
            </p>

            <label style={{ display: "block", fontSize: "var(--fs-xs)", color: "var(--text-secondary)", marginBottom: 4 }}>Source name</label>
            <input className="ds-input" value={name} placeholder="e.g. My Mix" onChange={(e) => setName(e.target.value)} style={{ marginBottom: 12 }} />

            <label style={{ display: "block", fontSize: "var(--fs-xs)", color: "var(--text-secondary)", marginBottom: 4 }}>Base URL (where you'll host it)</label>
            <input className="ds-input" value={baseUrl} placeholder="https://you.github.io/my-music/" onChange={(e) => setBaseUrl(e.target.value)} />
            <p style={{ fontSize: "var(--fs-2xs)", color: "var(--text-tertiary)", margin: "4px 0 12px" }}>
              This is where you'll host the folder — the shareable manifest link is built from it. Track refs inside the
              manifest stay relative, so you can re-host it anywhere without rebuilding. For GitHub Pages use{" "}
              <code>https://&lt;user&gt;.github.io/&lt;repo&gt;/</code> and create the repo with that name.
            </p>

            <label style={{ display: "block", fontSize: "var(--fs-xs)", color: "var(--text-secondary)", marginBottom: 4 }}>Output folder</label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={pickFolder}>Choose folder…</button>
              <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-tertiary)", wordBreak: "break-all" }}>{destDir ?? "No folder chosen"}</span>
            </div>

            <p style={{ fontSize: "var(--fs-2xs)", color: "var(--text-tertiary)", margin: "14px 0 0" }}>
              ⚠ Only publish audio you have the right to share — hosting it publicly distributes it.
            </p>

            {error && <p style={{ fontSize: "var(--fs-xs)", color: "var(--error)", margin: "10px 0 0" }}>{error}</p>}

            <div className="ds-modal-actions">
              <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="ds-btn ds-btn--primary ds-btn--sm" onClick={publish} disabled={!canPublish}>
                {busy ? "Publishing…" : "Publish"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="ds-modal-title">Music source ready</div>
            <p style={{ fontSize: "var(--fs-sm)", color: "var(--text-secondary)", margin: "8px 0 12px" }}>
              Bundled <strong>{result.exported}</strong> track{result.exported === 1 ? "" : "s"}
              {result.skipped.length > 0 && <> · skipped {result.skipped.length} (remote or missing)</>}.
            </p>

            <label style={{ display: "block", fontSize: "var(--fs-xs)", color: "var(--text-secondary)", marginBottom: 4 }}>Manifest URL (listeners add this)</label>
            <p><code style={{ fontSize: "var(--fs-xs)", wordBreak: "break-all" }}>{result.manifestUrl}</code></p>

            <label style={{ display: "block", fontSize: "var(--fs-xs)", color: "var(--text-secondary)", margin: "12px 0 4px" }}>Host on GitHub Pages — run inside the folder:</label>
            <p><code style={{ fontSize: "var(--fs-xs)", wordBreak: "break-all" }}>gh repo create my-music --public --source=. --remote=origin --push</code></p>
            <p style={{ fontSize: "var(--fs-2xs)", color: "var(--text-tertiary)", margin: "4px 0 0" }}>
              Then enable Pages (Settings → Pages → branch <code>main</code> / root). See <code>PUBLISH.md</code> in the folder for details. Or upload the folder to any web server.
            </p>

            <div className="ds-modal-actions" style={{ flexWrap: "wrap", gap: 8 }}>
              <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={() => invoke("open_folder", { folderPath: result.dest }).catch(console.error)}>Reveal folder</button>
              <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={() => openUrl("https://github.com/new").catch(console.error)}>Open GitHub</button>
              <button className="ds-btn ds-btn--primary ds-btn--sm" onClick={onClose}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
