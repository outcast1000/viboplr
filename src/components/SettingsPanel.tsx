import { useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { SearchProviderConfig } from "../searchProviders";
import { DEFAULT_PROVIDERS, getDomainFromUrl } from "../searchProviders";
import { IconGoogle, IconLastfm, IconX, IconYoutube, IconGenius } from "./Icons";
import type { TimingEntry } from "../startupTiming";
import type { UpdateState } from "../hooks/useAppUpdater";
import type { SkinInfo, GallerySkinEntry } from "../types/skin";

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
  onLastfmImportHistory: () => void;
  onLastfmCancelImport: () => void;
  lastfmImporting: boolean;
  lastfmImportProgress: { page: number; total_pages: number; imported: number; skipped: number } | null;
  lastfmImportResult: { imported: number; skipped: number } | null;
  onLastfmImportResultDismiss: () => void;
  downloadFormat: string;
  onDownloadFormatChange: (format: string) => void;
  tidalEnabled: boolean;
  onTidalEnabledChange: (enabled: boolean) => void;
  musicGatewayUrl: string;
  onMusicGatewayUrlChange: (url: string) => void;
  musicGatewayExePath: string;
  onMusicGatewayExePathChange: (path: string) => void;
  musicGatewayManaged: boolean;
  onMusicGatewayManagedChange: (managed: boolean) => void;
  // Skins
  activeSkinId: string;
  installedSkins: SkinInfo[];
  onApplySkin: (id: string) => void;
  onImportSkin: () => void;
  onDeleteSkin: (id: string) => void;
  gallerySkins: GallerySkinEntry[];
  galleryLoading: boolean;
  galleryError: string | null;
  onFetchGallery: () => void;
  onInstallFromGallery: (entry: GallerySkinEntry) => void;
}

interface ProviderFormData {
  name: string;
  artistUrl: string;
  albumUrl: string;
  trackUrl: string;
}

type SettingsTab = "general" | "skins" | "tidal" | "lastfm" | "providers" | "about" | "debug";

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
  onLastfmImportHistory,
  onLastfmCancelImport,
  lastfmImporting,
  lastfmImportProgress,
  lastfmImportResult,
  onLastfmImportResultDismiss,
  downloadFormat,
  onDownloadFormatChange,
  tidalEnabled,
  onTidalEnabledChange,
  musicGatewayUrl,
  onMusicGatewayUrlChange,
  musicGatewayExePath,
  onMusicGatewayExePathChange,
  musicGatewayManaged,
  onMusicGatewayManagedChange,
  activeSkinId,
  installedSkins,
  onApplySkin,
  onImportSkin,
  onDeleteSkin,
  gallerySkins,
  galleryLoading,
  galleryError,
  onFetchGallery,
  onInstallFromGallery,
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

  const [showImportModal, setShowImportModal] = useState(false);

  const tidalIcon = <svg {...iconProps}><path d="M2 16l5-5 5 5-5 5z"/><path d="M7 11l5-5 5 5-5 5z"/><path d="M12 16l5-5 5 5-5 5z"/><path d="M12 6l5-5 5 5-5 5z"/></svg>;

  const skinsIcon = <svg {...iconProps}><circle cx="13.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12" r="1.5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.5-.7 1.5-1.5 0-.4-.1-.7-.4-1-.2-.3-.4-.6-.4-1 0-.8.7-1.5 1.5-1.5H16c3.3 0 6-2.7 6-6 0-5.5-4.5-9.5-10-9.5z"/></svg>;

  const navItems: { key: SettingsTab; label: string; icon: ReactNode }[] = [
    { key: "general", label: "General", icon: navIcons.general },
    { key: "skins", label: "Skins", icon: skinsIcon },
    { key: "tidal", label: "TIDAL", icon: tidalIcon },
    { key: "lastfm", label: "Last.fm", icon: <>{IconLastfm({ size: 18 })}</> },
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
              </>
            )}

            {settingsTab === "skins" && (() => {
              const activeSkin = installedSkins.find(s => s.id === activeSkinId);
              return (
                <>
                  <div className="skin-active-indicator">
                    <div>
                      <span style={{ fontWeight: 600 }}>{activeSkin?.name ?? "Default"}</span>
                      <span style={{ marginLeft: 8, fontSize: "var(--fs-2xs)", color: "var(--text-secondary)" }}>
                        {activeSkin?.source === "builtin" ? "Built-in" : activeSkin?.author ?? ""}
                      </span>
                    </div>
                    <span style={{ fontSize: "var(--fs-2xs)", color: "var(--text-secondary)" }}>Active</span>
                  </div>

                  <div className="settings-group">
                    <div className="settings-group-title">Installed Skins</div>
                    <div className="skin-cards-grid">
                      {installedSkins.map(skin => (
                        <div
                          key={skin.id}
                          className={`skin-card${skin.id === activeSkinId ? " active" : ""}`}
                          onClick={() => onApplySkin(skin.id)}
                        >
                          <div className="skin-card-swatches">
                            <div style={{ background: skin.colors["bg-primary"] }} />
                            <div style={{ background: skin.colors["bg-secondary"] }} />
                            <div style={{ background: skin.colors["accent"] }} />
                            <div style={{ background: skin.colors["bg-surface"] }} />
                          </div>
                          <div className="skin-card-info">
                            <div className="skin-card-name">{skin.name}</div>
                            <div className="skin-card-meta">
                              {skin.source === "builtin" ? "Built-in" : skin.author}
                            </div>
                            {skin.source === "user" && (
                              <span
                                className="skin-card-remove"
                                onClick={e => { e.stopPropagation(); onDeleteSkin(skin.id); }}
                              >
                                Remove
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="skin-actions">
                    <button className="settings-btn-secondary" onClick={onImportSkin}>Import from file...</button>
                    <button className="settings-btn-secondary" onClick={onFetchGallery}>Browse Gallery</button>
                  </div>

                  {(gallerySkins.length > 0 || galleryLoading || galleryError) && (
                    <div className="skin-gallery">
                      <div className="settings-group-title" style={{ marginTop: 0 }}>Gallery</div>
                      {galleryLoading && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-secondary)", fontSize: "var(--fs-xs)", padding: "12px 0" }}>
                          <svg width="16" height="16" viewBox="0 0 16 16" style={{ animation: "status-spin 1s linear infinite" }}>
                            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" />
                          </svg>
                          Loading gallery...
                        </div>
                      )}
                      {galleryError && (
                        <div style={{ color: "var(--error)", fontSize: "var(--fs-xs)" }}>
                          {galleryError}
                          <button className="settings-btn-secondary" style={{ marginLeft: 10 }} onClick={onFetchGallery}>Retry</button>
                        </div>
                      )}
                      {!galleryLoading && !galleryError && gallerySkins.length > 0 && (
                        <div className="skin-cards-grid">
                          {gallerySkins.map(entry => (
                            <div key={entry.id} className="skin-gallery-card">
                              <div className="skin-card-swatches">
                                <div style={{ background: entry.colors[0] }} />
                                <div style={{ background: entry.colors[1] }} />
                                <div style={{ background: entry.colors[2] }} />
                                <div style={{ background: entry.colors[3] }} />
                              </div>
                              <div className="skin-gallery-card-footer">
                                <div>
                                  <div className="skin-card-name">{entry.name}</div>
                                  <div className="skin-card-meta">{entry.author}</div>
                                </div>
                                <button className="skin-install-btn" onClick={() => onInstallFromGallery(entry)}>Install</button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              );
            })()}

            {settingsTab === "tidal" && (
              <TidalSettingsTab
                tidalEnabled={tidalEnabled}
                onTidalEnabledChange={onTidalEnabledChange}
                musicGatewayUrl={musicGatewayUrl}
                onMusicGatewayUrlChange={onMusicGatewayUrlChange}
                musicGatewayExePath={musicGatewayExePath}
                onMusicGatewayExePathChange={onMusicGatewayExePathChange}
                musicGatewayManaged={musicGatewayManaged}
                onMusicGatewayManagedChange={onMusicGatewayManagedChange}
                downloadFormat={downloadFormat}
                onDownloadFormatChange={onDownloadFormatChange}
              />
            )}

            {settingsTab === "lastfm" && (
              <>
                <div className="settings-group">
                  <div className="settings-group-title">Account</div>
                  <div className="settings-card">
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Connection</span>
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
                    {lastfmConnected && lastfmUsername && (
                      <div className="settings-row">
                        <div className="settings-row-info">
                          <span className="settings-label">Profile</span>
                          <span className="settings-description">
                            <a href="#" onClick={(e) => { e.preventDefault(); openUrl(`https://www.last.fm/user/${lastfmUsername}`); }}>
                              last.fm/user/{lastfmUsername}
                            </a>
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="settings-group">
                  <div className="settings-group-title">History</div>
                  <div className="settings-card">
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Import scrobble history</span>
                        <span className="settings-description">
                          Import your complete listening history from Last.fm
                        </span>
                      </div>
                      <button
                        className="settings-btn-secondary"
                        onClick={() => { setShowImportModal(true); onLastfmImportHistory(); }}
                        disabled={!lastfmConnected || lastfmImporting}
                      >
                        Import
                      </button>
                    </div>
                  </div>
                </div>

                {showImportModal && (
                  <div className="lastfm-import-modal-overlay" onClick={() => { if (!lastfmImporting) { setShowImportModal(false); onLastfmImportResultDismiss(); } }}>
                    <div className="lastfm-import-modal" onClick={e => e.stopPropagation()}>
                      <h3>Import Last.fm History</h3>

                      {lastfmImporting && lastfmImportProgress && (
                        <div className="lastfm-import-progress">
                          <div className="lastfm-import-progress-bar">
                            <div
                              className="lastfm-import-progress-fill"
                              style={{ width: `${Math.round((lastfmImportProgress.page / lastfmImportProgress.total_pages) * 100)}%` }}
                            />
                          </div>
                          <div className="lastfm-import-stats">
                            <span>Page {lastfmImportProgress.page} of {lastfmImportProgress.total_pages}</span>
                            <span>{lastfmImportProgress.imported} imported, {lastfmImportProgress.skipped} skipped</span>
                          </div>
                        </div>
                      )}

                      {lastfmImporting && !lastfmImportProgress && (
                        <div className="lastfm-import-progress">
                          <span className="lastfm-import-status">Connecting to Last.fm...</span>
                        </div>
                      )}

                      {!lastfmImporting && lastfmImportResult && (
                        <div className="lastfm-import-done">
                          <span className="lastfm-import-status">Import complete</span>
                          <span className="lastfm-import-stats-final">
                            {lastfmImportResult.imported} imported, {lastfmImportResult.skipped} skipped
                          </span>
                        </div>
                      )}

                      {!lastfmImporting && !lastfmImportResult && (
                        <div className="lastfm-import-done">
                          <span className="lastfm-import-status">Import cancelled</span>
                        </div>
                      )}

                      <div className="lastfm-import-modal-actions">
                        {lastfmImporting ? (
                          <button className="settings-btn-secondary" onClick={onLastfmCancelImport}>Cancel</button>
                        ) : (
                          <button className="settings-btn-accent" onClick={() => { setShowImportModal(false); onLastfmImportResultDismiss(); }}>Close</button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
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

function TidalSettingsTab({
  tidalEnabled, onTidalEnabledChange,
  musicGatewayUrl, onMusicGatewayUrlChange,
  musicGatewayExePath, onMusicGatewayExePathChange,
  musicGatewayManaged, onMusicGatewayManagedChange,
  downloadFormat, onDownloadFormatChange,
}: {
  tidalEnabled: boolean;
  onTidalEnabledChange: (enabled: boolean) => void;
  musicGatewayUrl: string;
  onMusicGatewayUrlChange: (url: string) => void;
  musicGatewayExePath: string;
  onMusicGatewayExePathChange: (path: string) => void;
  musicGatewayManaged: boolean;
  onMusicGatewayManagedChange: (managed: boolean) => void;
  downloadFormat: string;
  onDownloadFormatChange: (format: string) => void;
}) {
  const [urlDraft, setUrlDraft] = useState(musicGatewayUrl || "http://localhost:7171");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  async function handleTestConnection() {
    const url = (urlDraft || "http://localhost:7171").trim();
    setTesting(true);
    setTestResult(null);
    try {
      const result = await invoke<{ version: string; bin: string | null }>("musicgateway_ping", { url });
      setTestResult({ ok: true, message: `Connected (v${result.version})` });
      onMusicGatewayUrlChange(url);
      if (result.bin) {
        onMusicGatewayExePathChange(result.bin);
      }
    } catch (e) {
      setTestResult({ ok: false, message: String(e) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <>
      <div className="settings-group">
        <div className="settings-group-title">MusicGateAway</div>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-label">Enable TIDAL</span>
              <span className="settings-description">Search, stream and download from the TIDAL catalog</span>
            </div>
            <ToggleSwitch checked={tidalEnabled} onChange={onTidalEnabledChange} />
          </div>
        </div>
        {tidalEnabled && (
          <>
            <div className="settings-mga-info">
              <p>
                TIDAL features require a{" "}
                <a href="#" onClick={(e) => { e.preventDefault(); openUrl("https://musicgateaway.j-15.com"); }}>
                  MusicGateAway
                </a>{" "}
                server. Install it from{" "}
                <a href="#" onClick={(e) => { e.preventDefault(); openUrl("https://musicgateaway.j-15.com"); }}>
                  musicgateaway.j-15.com
                </a>
                .
              </p>
            </div>

            <div className="settings-card" style={{ marginTop: 8 }}>
              {musicGatewayExePath && (
                <>
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <span className="settings-label">Application path</span>
                      <span className="settings-description settings-mga-path-display">
                        {musicGatewayExePath}
                      </span>
                    </div>
                  </div>
                  <div className="settings-card-divider" />
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <span className="settings-label">Manage server lifecycle</span>
                      <span className="settings-description">Start on launch, stop on quit</span>
                    </div>
                    <ToggleSwitch
                      checked={musicGatewayManaged}
                      onChange={onMusicGatewayManagedChange}
                    />
                  </div>
                  <div className="settings-card-divider" />
                </>
              )}
              <div className="settings-card-divider" />
              <div className="settings-row">
                <div className="settings-row-info">
                  <span className="settings-label">Connection</span>
                  {testResult ? (
                    <span className={`settings-description ${testResult.ok ? "settings-mga-test-ok" : "settings-mga-test-err"}`}>
                      {testResult.message}
                    </span>
                  ) : (
                    <span className="settings-description">
                      {musicGatewayUrl ? `Server: ${musicGatewayUrl}` : "Not connected"}
                    </span>
                  )}
                </div>
                <button
                  className="settings-btn-secondary"
                  onClick={handleTestConnection}
                  disabled={testing}
                >
                  {testing ? "Testing..." : "Test Connection"}
                </button>
              </div>
            </div>

            <button
              className="settings-mga-advanced-toggle"
              style={{ marginTop: 6 }}
              onClick={() => setShowAdvanced(!showAdvanced)}
            >
              {showAdvanced ? "Hide" : "Show"} advanced options
            </button>
            {showAdvanced && (
              <div className="settings-mga-advanced" style={{ marginTop: 4 }}>
                <label className="settings-mga-url-label">Server URL</label>
                <input
                  type="text"
                  className="settings-text-input"
                  value={urlDraft}
                  onChange={(e) => { setUrlDraft(e.target.value); setTestResult(null); }}
                  placeholder="http://localhost:7171"
                />
                <span className="settings-mga-url-hint">Only change if your server runs on a different address</span>
              </div>
            )}
          </>
        )}
      </div>

      {tidalEnabled && (
        <div className="settings-group">
          <div className="settings-group-title">Download Format</div>
          <div className="settings-card">
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-label">Preferred format</span>
                <span className="settings-description">Format used when saving tracks from TIDAL</span>
              </div>
              <select
                value={downloadFormat}
                onChange={(e) => onDownloadFormatChange(e.target.value)}
                className="settings-select"
              >
                <option value="flac">FLAC (Lossless)</option>
                <option value="aac">M4A (AAC)</option>
              </select>
            </div>
          </div>
        </div>
      )}
    </>
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
