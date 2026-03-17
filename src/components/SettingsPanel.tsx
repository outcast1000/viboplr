import { useState, type ReactNode } from "react";
import type { Collection } from "../types";
import { collectionKindLabel } from "../utils";
import type { SearchProviderConfig } from "../searchProviders";
import { DEFAULT_PROVIDERS, getDomainFromUrl } from "../searchProviders";
import { IconGoogle, IconLastfm, IconX, IconYoutube, IconGenius } from "./Icons";
import { EditCollectionModal } from "./EditCollectionModal";
import type { TimingEntry } from "../startupTiming";

export interface UpdateState {
  available: { version: string; body: string } | null;
  checking: boolean;
  downloading: boolean;
  progress: { downloaded: number; total: number } | null;
  upToDate: boolean;
}

const BUILTIN_ICONS: Record<string, (p: { size?: number }) => ReactNode> = {
  google: IconGoogle,
  lastfm: IconLastfm,
  x: IconX,
  youtube: IconYoutube,
  genius: IconGenius,
};

function SettingsProviderIcon({ provider }: { provider: SearchProviderConfig }) {
  const [imgError, setImgError] = useState(false);

  if (provider.builtinIcon && BUILTIN_ICONS[provider.builtinIcon]) {
    const Icon = BUILTIN_ICONS[provider.builtinIcon];
    return <>{Icon({ size: 16 })}</>;
  }

  const url = provider.artistUrl || provider.albumUrl || provider.trackUrl || "";
  const domain = getDomainFromUrl(url);

  if (domain && !imgError) {
    return (
      <img
        className="provider-icon-img"
        src={`https://www.google.com/s2/favicons?domain=${domain}&sz=32`}
        width={16}
        height={16}
        onError={() => setImgError(true)}
        alt=""
      />
    );
  }

  return (
    <span className="provider-icon-fallback">
      {provider.name[0]?.toUpperCase() ?? "?"}
    </span>
  );
}

function formatSyncDuration(secs: number): string {
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = Math.round(secs % 60);
  return `${mins}m ${remainSecs}s`;
}

function formatTimeAgo(ts: number): string {
  const diffSecs = Math.floor(Date.now() / 1000) - ts;
  if (diffSecs < 60) return "just now";
  if (diffSecs < 3600) return `${Math.floor(diffSecs / 60)}m ago`;
  if (diffSecs < 86400) return `${Math.floor(diffSecs / 3600)}h ago`;
  return `${Math.floor(diffSecs / 86400)}d ago`;
}

interface SettingsPanelProps {
  collections: Collection[];
  searchProviders: SearchProviderConfig[];
  onClose: () => void;
  onAddFolder: () => void;
  onShowAddServer: () => void;
  onRemoveCollection: (id: number) => void;
  onResyncCollection: (id: number) => void;
  onUpdateCollection: (id: number, name: string, autoUpdate: boolean, autoUpdateIntervalMins: number, enabled: boolean) => void;
  onToggleCollectionEnabled: (collection: Collection) => void;
  onSeedDatabase: () => void;
  onClearDatabase: () => void;
  clearing: boolean;
  onClearImageFailures: () => void;
  crossfadeSecs: number;
  onCrossfadeChange: (secs: number) => void;
  onSaveProviders: (providers: SearchProviderConfig[]) => void;
  appVersion: string;
  updateState: UpdateState;
  onCheckForUpdates: () => void;
  onInstallUpdate: () => void;
  backendTimings: TimingEntry[];
  frontendTimings: TimingEntry[];
  onFetchBackendTimings: () => void;
}

interface ProviderFormData {
  name: string;
  artistUrl: string;
  albumUrl: string;
  trackUrl: string;
}

export function SettingsPanel({
  collections, searchProviders,
  onClose, onAddFolder, onShowAddServer,
  onRemoveCollection, onResyncCollection, onUpdateCollection, onToggleCollectionEnabled,
  onSeedDatabase, onClearDatabase, clearing,
  onClearImageFailures, onSaveProviders,
  crossfadeSecs,
  onCrossfadeChange,
  appVersion,
  updateState,
  onCheckForUpdates,
  onInstallUpdate,
  backendTimings,
  frontendTimings,
  onFetchBackendTimings,
}: SettingsPanelProps) {
  const [settingsTab, setSettingsTab] = useState<"main" | "collections" | "providers" | "about" | "debug">("main");
  const [editingCollection, setEditingCollection] = useState<Collection | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<ProviderFormData>({ name: "", artistUrl: "", albumUrl: "", trackUrl: "" });

  function startEdit(provider: SearchProviderConfig) {
    setEditingId(provider.id);
    setAdding(false);
    setForm({
      name: provider.name,
      artistUrl: provider.artistUrl ?? "",
      albumUrl: provider.albumUrl ?? "",
      trackUrl: provider.trackUrl ?? "",
    });
  }

  function startAdd() {
    setAdding(true);
    setEditingId(null);
    setForm({ name: "", artistUrl: "", albumUrl: "", trackUrl: "" });
  }

  function cancelEdit() {
    setEditingId(null);
    setAdding(false);
  }

  function saveEdit() {
    if (adding) {
      if (!form.name.trim()) return;
      const newProvider: SearchProviderConfig = {
        id: crypto.randomUUID(),
        name: form.name.trim(),
        enabled: true,
        artistUrl: form.artistUrl.trim() || undefined,
        albumUrl: form.albumUrl.trim() || undefined,
        trackUrl: form.trackUrl.trim() || undefined,
      };
      onSaveProviders([...searchProviders, newProvider]);
    } else if (editingId) {
      onSaveProviders(searchProviders.map((p) =>
        p.id === editingId
          ? {
              ...p,
              name: form.name.trim() || p.name,
              artistUrl: form.artistUrl.trim() || undefined,
              albumUrl: form.albumUrl.trim() || undefined,
              trackUrl: form.trackUrl.trim() || undefined,
            }
          : p,
      ));
    }
    setEditingId(null);
    setAdding(false);
  }

  function toggleEnabled(id: string) {
    onSaveProviders(searchProviders.map((p) =>
      p.id === id ? { ...p, enabled: !p.enabled } : p,
    ));
  }

  function deleteProvider(id: string) {
    onSaveProviders(searchProviders.filter((p) => p.id !== id));
  }

  function resetToDefaults() {
    onSaveProviders(DEFAULT_PROVIDERS);
    setEditingId(null);
    setAdding(false);
  }

  const isEditing = editingId !== null || adding;

  return (
    <div className="settings-overlay">
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close" onClick={onClose}>{"\u00D7"}</button>
        </div>

        <div className="settings-tabs">
          <button className={`settings-tab ${settingsTab === "main" ? "active" : ""}`} onClick={() => setSettingsTab("main")}>Main</button>
          <button className={`settings-tab ${settingsTab === "collections" ? "active" : ""}`} onClick={() => setSettingsTab("collections")}>Collections</button>
          <button className={`settings-tab ${settingsTab === "providers" ? "active" : ""}`} onClick={() => setSettingsTab("providers")}>Providers</button>
          <button className={`settings-tab ${settingsTab === "about" ? "active" : ""}`} onClick={() => setSettingsTab("about")}>About</button>
          <button className={`settings-tab ${settingsTab === "debug" ? "active" : ""}`} onClick={() => { setSettingsTab("debug"); onFetchBackendTimings(); }}>Debug</button>
        </div>

        {settingsTab === "main" && (
          <div className="settings-section">
            <div className="settings-row">
              <label className="settings-label">Crossfade</label>
              <input
                type="range"
                min={0}
                max={10}
                step={0.5}
                value={crossfadeSecs}
                onChange={e => onCrossfadeChange(parseFloat(e.target.value))}
                className="settings-slider"
              />
              <span className="settings-value">{crossfadeSecs === 0 ? "Off" : `${crossfadeSecs.toFixed(1)}s`}</span>
            </div>
            <button className="add-folder-btn" onClick={onClearImageFailures}>
              Retry Failed Image Downloads
            </button>
          </div>
        )}

        {settingsTab === "collections" && (
          <div className="settings-section">
            {collections.map((c) => (
              <div key={c.id} className={`collection-card${!c.enabled ? " collection-card-disabled" : ""}`}>
                <div className="collection-card-header">
                  <button
                    className={`collection-enable-toggle ${c.enabled ? "collection-enable-toggle-on" : ""}`}
                    onClick={() => onToggleCollectionEnabled(c)}
                    title={c.enabled ? "Disable" : "Enable"}
                  >
                    {c.enabled ? "On" : "Off"}
                  </button>
                  <span className={`collection-kind collection-kind-${c.kind}`}>
                    {collectionKindLabel(c.kind)}
                  </span>
                  <span className="collection-card-name" title={c.path || c.url || c.name}>
                    {c.name}
                  </span>
                  <button
                    className="collection-action collection-edit"
                    onClick={() => setEditingCollection(c)}
                    title="Edit"
                  >
                    {"\u270E"}
                  </button>
                  <button
                    className="collection-action collection-resync"
                    onClick={() => onResyncCollection(c.id)}
                    title="Resync"
                  >
                    {"\u21BB"}
                  </button>
                  <button
                    className="collection-action collection-remove"
                    onClick={() => onRemoveCollection(c.id)}
                    title="Remove"
                  >
                    {"\u00D7"}
                  </button>
                </div>
                <div className="collection-card-details">
                  {c.path && <span className="collection-card-detail" title={c.path}>{c.path}</span>}
                  {c.url && <span className="collection-card-detail">{c.url}</span>}
                  {c.last_synced_at && (
                    <span className="collection-card-detail">
                      Synced {formatTimeAgo(c.last_synced_at)}
                      {c.last_sync_duration_secs != null && <> in {formatSyncDuration(c.last_sync_duration_secs)}</>}
                    </span>
                  )}
                  {c.auto_update && (
                    <span className="collection-card-detail">Auto-update every {c.auto_update_interval_mins < 60 ? `${c.auto_update_interval_mins}m` : `${c.auto_update_interval_mins / 60}h`}</span>
                  )}
                </div>
              </div>
            ))}
            <button className="add-folder-btn" onClick={onAddFolder}>
              + Add Folder
            </button>
            <button className="add-folder-btn" onClick={onShowAddServer}>
              + Add Server
            </button>
            {import.meta.env.DEV && (
              <button className="add-folder-btn" onClick={onSeedDatabase}>
                Seed Test Data
              </button>
            )}
            {import.meta.env.DEV && (
              <button className="add-folder-btn" onClick={onClearDatabase} disabled={clearing}>
                {clearing ? "Clearing..." : "Clear Database"}
              </button>
            )}
          </div>
        )}

        {settingsTab === "providers" && (
          <div className="settings-section">
            {isEditing ? (
              <div className="provider-form">
                <h3>{adding ? "Add Provider" : "Edit Provider"}</h3>
                <div className="provider-form-field">
                  <label>Name</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Provider name"
                  />
                </div>
                <div className="provider-form-field">
                  <label>Artist URL Template</label>
                  <input
                    type="text"
                    value={form.artistUrl}
                    onChange={(e) => setForm({ ...form, artistUrl: e.target.value })}
                    placeholder="https://example.com/search?q={artist}"
                  />
                </div>
                <div className="provider-form-field">
                  <label>Album URL Template</label>
                  <input
                    type="text"
                    value={form.albumUrl}
                    onChange={(e) => setForm({ ...form, albumUrl: e.target.value })}
                    placeholder="https://example.com/search?q={artist}+{title}"
                  />
                </div>
                <div className="provider-form-field">
                  <label>Track URL Template</label>
                  <input
                    type="text"
                    value={form.trackUrl}
                    onChange={(e) => setForm({ ...form, trackUrl: e.target.value })}
                    placeholder="https://example.com/search?q={artist}+{title}"
                  />
                </div>
                <div className="provider-form-hint">
                  Use {"{artist}"} and {"{title}"} as placeholders. Leave a URL blank to hide this provider for that context.
                </div>
                <div className="provider-form-actions">
                  <button className="modal-btn modal-btn-cancel" onClick={cancelEdit}>Cancel</button>
                  <button className="modal-btn modal-btn-confirm" onClick={saveEdit}>Save</button>
                </div>
              </div>
            ) : (
              <>
                <div className="provider-list">
                  {searchProviders.map((provider) => (
                    <div key={provider.id} className={`provider-item ${!provider.enabled ? "provider-disabled" : ""}`}>
                      <div className="provider-icon">
                        <SettingsProviderIcon provider={provider} />
                      </div>
                      <span className="provider-name">{provider.name}</span>
                      <div className="provider-contexts">
                        {provider.artistUrl && <span className="provider-context-chip">Artist</span>}
                        {provider.albumUrl && <span className="provider-context-chip">Album</span>}
                        {provider.trackUrl && <span className="provider-context-chip">Track</span>}
                      </div>
                      <button
                        className={`provider-toggle ${provider.enabled ? "provider-toggle-on" : ""}`}
                        onClick={() => toggleEnabled(provider.id)}
                        title={provider.enabled ? "Disable" : "Enable"}
                      >
                        {provider.enabled ? "On" : "Off"}
                      </button>
                      <button
                        className="provider-action"
                        onClick={() => startEdit(provider)}
                        title="Edit"
                      >
                        {"\u270E"}
                      </button>
                      {!provider.id.startsWith("builtin-") && (
                        <button
                          className="provider-action provider-delete"
                          onClick={() => deleteProvider(provider.id)}
                          title="Delete"
                        >
                          {"\u00D7"}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <button className="add-folder-btn" onClick={startAdd}>
                  + Add Provider
                </button>
                <button className="add-folder-btn" onClick={resetToDefaults}>
                  Reset to Defaults
                </button>
              </>
            )}
          </div>
        )}

        {settingsTab === "about" && (
          <div className="settings-section settings-about">
            <span className="settings-version">FastPlayer v{appVersion}</span>

            {updateState.available && !updateState.downloading && (
              <div className="update-available">
                <span className="update-version">v{updateState.available.version} available</span>
                {updateState.available.body && (
                  <p className="update-notes">{updateState.available.body}</p>
                )}
                <button className="add-folder-btn update-install-btn" onClick={onInstallUpdate}>
                  Download &amp; Install
                </button>
              </div>
            )}

            {updateState.downloading && (
              <div className="update-progress">
                <span>Downloading update...</span>
                {updateState.progress && updateState.progress.total > 0 && (
                  <div className="update-progress-bar">
                    <div
                      className="update-progress-fill"
                      style={{ width: `${Math.round((updateState.progress.downloaded / updateState.progress.total) * 100)}%` }}
                    />
                  </div>
                )}
              </div>
            )}

            {!updateState.available && !updateState.downloading && (
              <>
                {updateState.upToDate && (
                  <span className="update-up-to-date">You're up to date!</span>
                )}
                <button
                  className="add-folder-btn"
                  onClick={onCheckForUpdates}
                  disabled={updateState.checking}
                >
                  {updateState.checking ? "Checking..." : "Check for Updates"}
                </button>
              </>
            )}
          </div>
        )}

        {settingsTab === "debug" && (
          <div className="settings-section">
            <TimingTable title="Backend" entries={backendTimings} />
            <TimingTable title="Frontend" entries={frontendTimings} />
          </div>
        )}

      </div>

      {editingCollection && (
        <EditCollectionModal
          collection={editingCollection}
          onSave={(id, name, autoUpdate, autoUpdateIntervalMins, enabled) => {
            onUpdateCollection(id, name, autoUpdate, autoUpdateIntervalMins, enabled);
            setEditingCollection(null);
          }}
          onClose={() => setEditingCollection(null)}
        />
      )}
    </div>
  );
}

function TimingTable({ title, entries }: { title: string; entries: TimingEntry[] }) {
  const total = entries.reduce((sum, e) => sum + e.duration_ms, 0);
  return (
    <div className="debug-timing-section">
      <h3>{title}</h3>
      {entries.length === 0 ? (
        <span className="text-secondary">No timings recorded</span>
      ) : (
        <table className="debug-timing-table">
          <thead>
            <tr>
              <th>Step</th>
              <th>Duration (ms)</th>
              <th>Offset (ms)</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={i}>
                <td>{e.label}</td>
                <td className="debug-timing-value">{e.duration_ms.toFixed(2)}</td>
                <td className="debug-timing-value">{e.offset_ms.toFixed(2)}</td>
              </tr>
            ))}
            <tr className="debug-timing-total">
              <td>Total</td>
              <td className="debug-timing-value">{total.toFixed(2)}</td>
              <td></td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}
