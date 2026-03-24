import { useState, type ReactNode } from "react";
import type { SearchProviderConfig } from "../searchProviders";
import { DEFAULT_PROVIDERS, getDomainFromUrl } from "../searchProviders";
import { IconGoogle, IconLastfm, IconX, IconYoutube, IconGenius } from "./Icons";
import type { TimingEntry } from "../startupTiming";
import type { UpdateState } from "../hooks/useAppUpdater";

const BUILTIN_ICONS: Record<string, (p: { size?: number }) => ReactNode> = {
  google: IconGoogle,
  lastfm: IconLastfm,
  x: IconX,
  youtube: IconYoutube,
  genius: IconGenius,
};

const iconProps = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

const navIcons = {
  general: <svg {...iconProps}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1.08z"/></svg>,
  providers: <svg {...iconProps}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
  about: <svg {...iconProps}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>,
  debug: <svg {...iconProps}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>,
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

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={`toggle-switch ${checked ? "toggle-switch-on" : ""}`}
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
    >
      <span className="toggle-switch-thumb" />
    </button>
  );
}

interface SettingsPanelProps {
  searchProviders: SearchProviderConfig[];
  onClose: () => void;
  onSeedDatabase: () => void;
  onClearDatabase: () => void;
  clearing: boolean;
  onClearImageFailures: () => void;
  crossfadeSecs: number;
  onCrossfadeChange: (secs: number) => void;
  trackVideoHistory: boolean;
  onTrackVideoHistoryChange: (enabled: boolean) => void;
  onSaveProviders: (providers: SearchProviderConfig[]) => void;
  appVersion: string;
  updateState: UpdateState;
  onCheckForUpdates: () => void;
  onInstallUpdate: () => void;
  backendTimings: TimingEntry[];
  frontendTimings: TimingEntry[];
  onFetchBackendTimings: () => void;
  lastfmConnected: boolean;
  lastfmUsername: string | null;
  onLastfmConnect: () => void;
  onLastfmDisconnect: () => void;
  downloadFormat: string;
  onDownloadFormatChange: (format: string) => void;
  tidalEnabled: boolean;
  onTidalEnabledChange: (enabled: boolean) => void;
  tidalOverrideUrl: string;
  onTidalOverrideUrlChange: (url: string) => void;
}

interface ProviderFormData {
  name: string;
  artistUrl: string;
  albumUrl: string;
  trackUrl: string;
}

type SettingsTab = "general" | "providers" | "about" | "debug";

export function SettingsPanel({
  searchProviders,
  onClose,
  onSeedDatabase, onClearDatabase, clearing,
  onClearImageFailures, onSaveProviders,
  crossfadeSecs,
  onCrossfadeChange,
  trackVideoHistory,
  onTrackVideoHistoryChange,
  appVersion,
  updateState,
  onCheckForUpdates,
  onInstallUpdate,
  backendTimings,
  frontendTimings,
  onFetchBackendTimings,
  lastfmConnected,
  lastfmUsername,
  onLastfmConnect,
  onLastfmDisconnect,
  downloadFormat,
  onDownloadFormatChange,
  tidalEnabled,
  onTidalEnabledChange,
  tidalOverrideUrl,
  onTidalOverrideUrlChange,
}: SettingsPanelProps) {
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
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

  const navItems: { key: SettingsTab; label: string; icon: ReactNode }[] = [
    { key: "general", label: "General", icon: navIcons.general },
    { key: "providers", label: "Providers", icon: navIcons.providers },
    { key: "about", label: "About", icon: navIcons.about },
    { key: "debug", label: "Debug", icon: navIcons.debug },
  ];

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-sidebar">
          <div className="settings-sidebar-title">Settings</div>
          <nav className="settings-nav">
            {navItems.map(item => (
              <button
                key={item.key}
                className={`settings-nav-item ${settingsTab === item.key ? "active" : ""}`}
                onClick={() => {
                  setSettingsTab(item.key);
                  if (item.key === "debug") onFetchBackendTimings();
                }}
              >
                <span className="settings-nav-icon">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="settings-content">
          <div className="settings-content-header">
            <h2>{navItems.find(n => n.key === settingsTab)?.label}</h2>
            <button className="settings-close" onClick={onClose}>{"\u00D7"}</button>
          </div>

          <div className="settings-content-body">
            {settingsTab === "general" && (
              <>
                <div className="settings-group">
                  <div className="settings-group-title">Playback</div>
                  <div className="settings-card">
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Crossfade</span>
                        <span className="settings-description">Smooth transition between tracks</span>
                      </div>
                      <div className="settings-row-control settings-row-slider">
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
                    </div>
                  </div>
                </div>

                <div className="settings-group">
                  <div className="settings-group-title">History</div>
                  <div className="settings-card">
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Track video history</span>
                        <span className="settings-description">Record playback of video files</span>
                      </div>
                      <ToggleSwitch checked={trackVideoHistory} onChange={onTrackVideoHistoryChange} />
                    </div>
                  </div>
                </div>

                <div className="settings-group">
                  <div className="settings-group-title">Integrations</div>
                  <div className="settings-card">
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Last.fm</span>
                        <span className="settings-description">
                          {lastfmConnected
                            ? <>Scrobbling as <strong style={{ color: "#d51007" }}>{lastfmUsername}</strong></>
                            : "Connect to scrobble your plays"
                          }
                        </span>
                      </div>
                      {lastfmConnected ? (
                        <button className="settings-btn-secondary" onClick={onLastfmDisconnect}>Disconnect</button>
                      ) : (
                        <button className="settings-btn-accent" onClick={onLastfmConnect} style={{ background: "#d51007", borderColor: "#d51007" }}>Connect</button>
                      )}
                    </div>
                    <div className="settings-card-divider" />
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">TIDAL</span>
                        <span className="settings-description">Stream from TIDAL catalog</span>
                      </div>
                      <ToggleSwitch checked={tidalEnabled} onChange={onTidalEnabledChange} />
                    </div>
                    {tidalEnabled && (
                      <div className="settings-row settings-row-sub">
                        <div className="settings-row-info">
                          <span className="settings-label">Override URL</span>
                        </div>
                        <input
                          type="text"
                          className="settings-text-input"
                          value={tidalOverrideUrl}
                          onChange={(e) => onTidalOverrideUrlChange(e.target.value)}
                          placeholder="Auto-discover (leave blank)"
                        />
                      </div>
                    )}
                  </div>
                </div>

                <div className="settings-group">
                  <div className="settings-group-title">Downloads</div>
                  <div className="settings-card">
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Format</span>
                        <span className="settings-description">Preferred format for downloaded tracks</span>
                      </div>
                      <select
                        value={downloadFormat}
                        onChange={(e) => onDownloadFormatChange(e.target.value)}
                        className="settings-select"
                      >
                        <option value="flac">FLAC (Lossless)</option>
                        <option value="aac">AAC</option>
                        <option value="mp3">MP3</option>
                      </select>
                    </div>
                  </div>
                </div>
              </>
            )}

            {settingsTab === "providers" && (
              <div className="settings-group">
                <div className="settings-group-title">Search Providers</div>
                {isEditing ? (
                  <div className="settings-card">
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
                        <button className="settings-btn-secondary" onClick={cancelEdit}>Cancel</button>
                        <button className="settings-btn-accent" onClick={saveEdit}>Save</button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="settings-card settings-card-flush">
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
                            <ToggleSwitch checked={provider.enabled} onChange={() => toggleEnabled(provider.id)} />
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
                    </div>
                    <div className="settings-actions-row">
                      <button className="settings-btn-secondary" onClick={startAdd}>+ Add Provider</button>
                      <button className="settings-btn-secondary" onClick={resetToDefaults}>Reset to Defaults</button>
                    </div>
                  </>
                )}
              </div>
            )}

            {settingsTab === "about" && (
              <div className="settings-about-content">
                <div className="settings-about-logo">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                  </svg>
                </div>
                <span className="settings-about-name">Viboplr</span>
                <span className="settings-about-version">v{appVersion}</span>

                {updateState.available && !updateState.downloading && (
                  <div className="update-available">
                    <span className="update-version">v{updateState.available.version} available</span>
                    {updateState.available.body && (
                      <p className="update-notes">{updateState.available.body}</p>
                    )}
                    <button className="settings-btn-accent update-install-btn" onClick={onInstallUpdate}>
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
                      <span className="update-up-to-date">Up to date</span>
                    )}
                    <button
                      className="settings-btn-secondary"
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
              <div className="settings-group">
                <div className="settings-group-title">Maintenance</div>
                <div className="settings-card">
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <span className="settings-label">Image cache</span>
                      <span className="settings-description">Retry previously failed image downloads</span>
                    </div>
                    <button className="settings-btn-secondary" onClick={onClearImageFailures}>Retry</button>
                  </div>
                </div>
                {import.meta.env.DEV && (
                  <>
                    <div className="settings-group-title" style={{ marginTop: 20 }}>Development</div>
                    <div className="settings-card">
                      <div className="settings-row">
                        <div className="settings-row-info">
                          <span className="settings-label">Test data</span>
                          <span className="settings-description">Seed or clear the database</span>
                        </div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <button className="settings-btn-secondary" onClick={onSeedDatabase}>Seed</button>
                          <button className="settings-btn-secondary" onClick={onClearDatabase} disabled={clearing}>
                            {clearing ? "Clearing..." : "Clear"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </>
                )}
                <div className="settings-group-title" style={{ marginTop: 20 }}>Startup Timings</div>
                <TimingTable title="Backend" entries={backendTimings} />
                <TimingTable title="Frontend" entries={frontendTimings} />
              </div>
            )}
          </div>
        </div>
      </div>
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
