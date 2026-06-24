import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  ExtensionItem,
  ExtensionUpdate,
  GalleryPluginEntry,
  PluginViewData,
} from "../types/plugin";
import type { GallerySkinEntry } from "../types/skin";
import { PluginViewRenderer } from "./PluginViewRenderer";
import { openUrl } from "@tauri-apps/plugin-opener";
import { LINKS } from "../constants/links";
import { summarizeContributes, skinMockColors } from "../utils/extensionSummary";

type ExtTab = "skins" | "plugins";

interface ExtensionsViewProps {
  allExtensions: ExtensionItem[];
  updateCount: number;
  searchQuery: string;
  onSetSearchQuery: (q: string) => void;
  installing: Set<string>;
  checking: boolean;
  lastChecked: number | null;
  onCheckForUpdates: () => void;
  onUpdateExtension: (id: string) => void;
  onUpdateAll: () => void;
  onInstallFromGallery: (entry: GalleryPluginEntry | GallerySkinEntry) => Promise<{ ok: boolean; kind: "plugin" | "skin"; error?: string }>;
  onUninstall: (id: string, kind: "plugin" | "skin") => void;
  onToggleEnabled: (id: string, kind: "plugin" | "skin") => void;
  onFetchPluginGallery: () => void;
  onFetchSkinGallery: () => void;
  onInstallFromUrl: (url: string) => Promise<void>;
  galleryPlugins: GalleryPluginEntry[];
  gallerySkins: GallerySkinEntry[];
  getPluginViewData?: (pluginId: string, viewId: string) => PluginViewData | undefined;
  onPluginAction?: (pluginId: string, actionId: string, data?: unknown) => void;
  // Gallery network state — drives skeletons + error/retry so the panel never
  // shows a silent gap while installable items load.
  pluginGalleryLoading?: boolean;
  pluginGalleryError?: string | null;
  skinGalleryLoading?: boolean;
  skinGalleryError?: string | null;
  // Live skin preview: pass a skin id to preview it window-wide, null to revert.
  onPreviewSkin?: (id: string | null) => void;
  // The view stays mounted (like Home/Library) and toggles visibility; the
  // gallery fetch is gated on becoming visible rather than on mount.
  isVisible?: boolean;
  style?: React.CSSProperties;
}

/* ── Shared bits ──────────────────────────────────────────────────────── */

function PluginIcon({ name, icon, large }: { name: string; icon?: string; large?: boolean }) {
  if (icon) {
    const s = large ? 28 : 22;
    return (
      <div className={`ext-icon ext-icon--plugin${large ? " ext-icon--lg" : ""}`}>
        <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d={icon} />
        </svg>
      </div>
    );
  }
  const letter = name.charAt(0).toUpperCase();
  return <div className={`ext-icon ext-icon--plugin${large ? " ext-icon--lg" : ""}`}>{letter}</div>;
}

function StatusBadge({ status, update }: { status: string; update?: ExtensionUpdate }) {
  if (update) return <span className="ext-badge ext-badge--update">update</span>;
  switch (status) {
    case "active": return <span className="ext-badge ext-badge--active">on</span>;
    case "incompatible": return <span className="ext-badge ext-badge--error">incompatible</span>;
    case "error": return <span className="ext-badge ext-badge--error">error</span>;
    case "disabled": return <span className="ext-badge ext-badge--disabled">off</span>;
    default: return null;
  }
}

function GalleryError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="ext-gallery-error" role="alert">
      <span>Couldn't reach the gallery.</span>
      <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={onRetry}>Retry</button>
    </div>
  );
}

function SectionHeader({ title, count, action }: { title: string; count: number; action?: React.ReactNode }) {
  if (count === 0 && !action) return null;
  return (
    <div className="ext-section-header">
      <span>{title}</span>
      {count > 0 && <span className="ext-section-count">{count}</span>}
      {action && <span className="ext-section-action">{action}</span>}
    </div>
  );
}

/* ── Plugins: cards + skeletons ───────────────────────────────────────── */

function PluginCard({
  ext, installing, onDetails, onConfig, onToggleEnabled, onInstall,
}: {
  ext: ExtensionItem; installing: boolean;
  onDetails: () => void; onConfig: () => void;
  onToggleEnabled: () => void; onInstall: () => void;
}) {
  const caps = useMemo(() => summarizeContributes(ext.contributes), [ext.contributes]);
  const installed = ext.status !== "not_installed";
  const isOn = ext.status === "active";
  const hasConfig = ext.status === "active" && !!ext.contributes?.settingsPanel?.id;
  return (
    <div className={`ext-pcard${!installed ? " ext-pcard--gallery" : ""}`}>
      <div className="ext-pcard-head">
        <PluginIcon name={ext.name} icon={ext.icon} />
        <div className="ext-pcard-titles">
          <div className="ext-pcard-name">
            <span className="ext-pcard-name-text">{ext.name}</span>
            {ext.source === "dev" && <span className="ext-dev-badge">DEV</span>}
            {!installed && ext.recommended && (
              <span className="ext-badge ext-badge--recommended">recommended</span>
            )}
            <StatusBadge status={ext.status} update={ext.updateAvailable} />
          </div>
          <div className="ext-pcard-meta">by {ext.author} · v{ext.version}</div>
        </div>
        {installed && ext.source !== "dev" && (
          <button
            type="button"
            className={`ds-toggle ext-pcard-toggle${isOn ? " on" : ""}`}
            role="switch"
            aria-checked={isOn}
            aria-label={isOn ? `Disable ${ext.name}` : `Enable ${ext.name}`}
            onClick={onToggleEnabled}
          >
            <span className="ds-toggle-thumb" />
          </button>
        )}
      </div>

      <div className="ext-pcard-desc">{ext.description}</div>

      {caps.length > 0 && (
        <div className="ext-chips ext-pcard-chips">
          {caps.slice(0, 4).map((c) => (
            <span key={c} className="ext-chip ext-chip--cap">{c}</span>
          ))}
          {caps.length > 4 && <span className="ext-chip">+{caps.length - 4}</span>}
        </div>
      )}

      <div className="ext-pcard-actions">
        {installed ? (
          <>
            <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={onDetails}>Details</button>
            {hasConfig && (
              <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={onConfig}>Config</button>
            )}
            {ext.updateAvailable?.status === "available" && (
              <span className="ext-badge ext-badge--update ext-pcard-update">update available</span>
            )}
          </>
        ) : (
          <>
            <button className="ds-btn ds-btn--primary ds-btn--sm" disabled={installing} onClick={onInstall}>
              {installing ? "Installing…" : "Install"}
            </button>
            <button className="ds-btn ds-btn--ghost ds-btn--sm" onClick={onDetails}>Details</button>
          </>
        )}
      </div>
    </div>
  );
}

function PluginCardSkeleton() {
  return (
    <div className="ext-pcard ext-pcard--skeleton" aria-hidden="true">
      <div className="ext-pcard-head">
        <div className="ext-sk ext-sk--icon" />
        <div style={{ flex: 1 }}>
          <div className="ext-sk" style={{ width: "55%", height: 12 }} />
          <div className="ext-sk" style={{ width: "35%", height: 8, marginTop: 8 }} />
        </div>
      </div>
      <div className="ext-sk" style={{ width: "100%", height: 9, marginTop: 12 }} />
      <div className="ext-sk" style={{ width: "70%", height: 9, marginTop: 7 }} />
    </div>
  );
}

/* ── Plugin detail pane ───────────────────────────────────────────────── */

function PluginDetail({
  ext, installing, onUpdate, onUninstall, onToggleEnabled, onInstall,
  getPluginViewData, onPluginAction, autoScrollToConfig,
}: {
  ext: ExtensionItem; installing: boolean; onUpdate: () => void; onUninstall: () => void;
  onToggleEnabled: () => void; onInstall: () => void;
  getPluginViewData?: (pluginId: string, viewId: string) => PluginViewData | undefined;
  onPluginAction?: (pluginId: string, actionId: string, data?: unknown) => void;
  autoScrollToConfig?: boolean;
}) {
  const isInstalled = ext.status !== "not_installed";
  const settingsPanelId = ext.status === "active" && ext.contributes?.settingsPanel?.id;
  const caps = useMemo(() => summarizeContributes(ext.contributes), [ext.contributes]);
  const configRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoScrollToConfig && settingsPanelId) {
      configRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [autoScrollToConfig, settingsPanelId]);

  return (
    <div className="ext-detail">
      <div className="ext-detail-header">
        <PluginIcon name={ext.name} icon={ext.icon} large />
        <div className="ext-detail-header-info">
          <div className="ext-detail-name">
            {ext.name}
            {ext.status === "active" && <span className="ext-badge ext-badge--active">enabled</span>}
            {!isInstalled && ext.recommended && (
              <span className="ext-badge ext-badge--recommended">recommended</span>
            )}
          </div>
          <div className="ext-detail-desc">{ext.description}</div>
          <div className="ext-detail-meta">
            By <strong>{ext.author}</strong> {"·"} v{ext.version} {"·"} Plugin
            {isInstalled && (<>{" · "}{ext.status === "active" ? "Enabled" : "Disabled"}</>)}
            {ext.source === "dev" && <span className="ext-dev-badge">DEV</span>}
          </div>
          {ext.source === "dev" && (
            <div className="ext-dev-notice">
              Loaded from dev folder{ext.devPath ? <>: <code>{ext.devPath}</code></> : null} (overrides the installed copy)
            </div>
          )}

          <div className="ext-detail-actions">
            {ext.updateAvailable && ext.updateAvailable.status === "available" && (
              <button className="ds-btn ds-btn--primary ds-btn--sm" onClick={onUpdate} disabled={installing}>
                {installing ? "Updating…" : `Update to v${ext.updateAvailable.latestVersion}`}
              </button>
            )}
            {ext.updateAvailable && ext.updateAvailable.status === "requires_app_update" && (
              <button className="ds-btn ds-btn--secondary ds-btn--sm" disabled>
                Requires app v{ext.updateAvailable.minAppVersion}
              </button>
            )}
            {isInstalled && (
              <>
                <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={onToggleEnabled}>
                  {ext.status === "active" ? "Disable" : "Enable"}
                </button>
                {ext.source !== "builtin" && (
                  <button className="ds-btn ds-btn--ghost ds-btn--sm" onClick={onUninstall}>Uninstall</button>
                )}
              </>
            )}
            {!isInstalled && (
              <button className="ds-btn ds-btn--primary ds-btn--sm" disabled={installing} onClick={onInstall}>
                {installing ? "Installing…" : "Install"}
              </button>
            )}
            {installing && (
              <span className="ext-detail-installing">
                <span className="ds-spinner ds-spinner--sm" />
                Working on {ext.name}…
              </span>
            )}
          </div>
        </div>
      </div>

      {ext.updateAvailable && ext.updateAvailable.changelog && (
        <div className="ext-detail-update-box">
          <div className="ext-detail-update-title">Update available · v{ext.updateAvailable.latestVersion}</div>
          <div className="ext-detail-update-changelog">{ext.updateAvailable.changelog}</div>
        </div>
      )}

      {settingsPanelId && (
        <div className="ext-detail-section" ref={configRef}>
          <div className="ext-detail-section-title">Configuration</div>
          <div className="ext-detail-settings">
            <PluginViewRenderer
              pluginName=""
              data={getPluginViewData?.(ext.id, settingsPanelId)}
              currentTrack={null}
              onAction={(actionId, actionData) => onPluginAction?.(ext.id, actionId, actionData)}
            />
          </div>
        </div>
      )}

      {caps.length > 0 && (
        <div className="ext-detail-section">
          <div className="ext-detail-section-title">Capabilities</div>
          <div className="ext-chips">
            {caps.map((c) => <span key={c} className="ext-chip ext-chip--cap">{c}</span>)}
          </div>
        </div>
      )}

      {ext.apiUsage && ext.apiUsage.length > 0 && (
        <div className="ext-detail-section">
          <div className="ext-detail-section-title">Permissions this plugin uses</div>
          <div className="ext-detail-api-usage-list">
            {ext.apiUsage.map((usage, i) => (
              <div key={i} className="ext-detail-api-usage-item">
                <code className="ext-detail-api-usage-api">{usage.api}</code>
                <span className="ext-detail-api-usage-reason">{usage.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="ext-detail-section">
        <div className="ext-detail-section-title">Information</div>
        <div className="ext-detail-info-grid">
          <span className="ext-detail-info-label">Version</span>
          <span>{ext.version}</span>
          <span className="ext-detail-info-label">Author</span>
          <span>{ext.author}</span>
          {ext.homepage && (
            <>
              <span className="ext-detail-info-label">Homepage</span>
              <span><a className="ext-detail-link" href={ext.homepage} target="_blank" rel="noopener noreferrer">{ext.homepage.replace(/^https?:\/\//, "")}</a></span>
            </>
          )}
          {ext.minAppVersion && (
            <>
              <span className="ext-detail-info-label">Min app version</span>
              <span>{ext.minAppVersion}</span>
            </>
          )}
          <span className="ext-detail-info-label">Source</span>
          <span>{ext.source}</span>
        </div>
      </div>
    </div>
  );
}

/* ── Skins: gallery grid ──────────────────────────────────────────────── */

function SkinCard({
  ext, installing, onApply, onInstall, onPreview, onClearPreview,
}: {
  ext: ExtensionItem; installing: boolean;
  onApply: () => void; onInstall: () => void;
  onPreview: () => void; onClearPreview: () => void;
}) {
  const installed = ext.status !== "not_installed";
  const active = ext.isActiveSkin === true;
  const m = useMemo(() => skinMockColors(ext.skinColors), [ext.skinColors]);
  const mockVars: React.CSSProperties = {
    ["--m-bg" as string]: m.bg,
    ["--m-side" as string]: m.sidebar,
    ["--m-surf" as string]: m.surface,
    ["--m-acc" as string]: m.accent,
    ["--m-txt" as string]: m.text,
    ["--m-np" as string]: m.nowPlaying,
  };

  // Live preview only for installed skins (gallery entries ship just 4 colors,
  // not the full palette needed to re-theme faithfully — their mock is enough).
  const previewable = installed;

  return (
    <button
      type="button"
      className={`ext-skin-card${active ? " ext-skin-card--active" : ""}`}
      onClick={installed ? onApply : onInstall}
      onMouseEnter={previewable ? onPreview : undefined}
      onMouseLeave={previewable ? onClearPreview : undefined}
      onBlur={previewable ? onClearPreview : undefined}
      aria-label={installed ? `Apply ${ext.name} skin` : `Install ${ext.name} skin`}
    >
      <div className="ext-skin-mock" style={mockVars}>
        <div className="ext-skin-mock-side">
          <i className="is-acc" /><i /><i /><i />
        </div>
        <div className="ext-skin-mock-main">
          <div className="ext-skin-mock-rowline"><span className="dot" /><span className="ln" /></div>
          <div className="ext-skin-mock-rowline"><span className="dot" /><span className="ln s" /></div>
          <div className="ext-skin-mock-rowline"><span className="dot" /><span className="ln" /></div>
        </div>
        <div className="ext-skin-mock-play">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
        </div>
        <div className="ext-skin-mock-np" />
        {ext.source === "dev" && <span className="ext-dev-badge ext-skin-dev">DEV</span>}
      </div>
      <div className="ext-skin-meta">
        <div className="ext-skin-meta-text">
          <div className="ext-skin-name">{ext.name}</div>
          <div className="ext-skin-type">{ext.skinType === "light" ? "Light theme" : "Dark theme"}</div>
        </div>
        <div className="ext-skin-meta-right">
          {installing ? (
            <span className="ds-spinner ds-spinner--sm" />
          ) : active ? (
            <span className="ext-skin-active">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" /></svg>
              Active
            </span>
          ) : (
            <span className="ext-skin-cta">{installed ? "Apply" : "Install"}</span>
          )}
        </div>
      </div>
    </button>
  );
}

function SkinCardSkeleton() {
  return (
    <div className="ext-skin-card ext-skin-card--skeleton" aria-hidden="true">
      <div className="ext-sk" style={{ height: 124, borderRadius: 0 }} />
      <div className="ext-skin-meta">
        <div style={{ flex: 1 }}>
          <div className="ext-sk" style={{ width: "60%", height: 11 }} />
          <div className="ext-sk" style={{ width: "40%", height: 8, marginTop: 7 }} />
        </div>
      </div>
    </div>
  );
}

/* ── Main view ────────────────────────────────────────────────────────── */

export default function ExtensionsView(props: ExtensionsViewProps) {
  const {
    allExtensions, updateCount,
    searchQuery, onSetSearchQuery, installing, checking,
    onCheckForUpdates, onUpdateExtension, onUpdateAll, onInstallFromGallery,
    onUninstall, onToggleEnabled, onFetchPluginGallery, onFetchSkinGallery,
    onInstallFromUrl, galleryPlugins, gallerySkins, getPluginViewData, onPluginAction,
    pluginGalleryLoading, pluginGalleryError, skinGalleryLoading, skinGalleryError,
    onPreviewSkin, isVisible = true, style,
  } = props;

  const [tab, setTab] = useState<ExtTab>("plugins");
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [urlValue, setUrlValue] = useState("");
  const [urlInstalling, setUrlInstalling] = useState(false);
  // After a successful gallery install (plugins land disabled), prompt to enable.
  const [enablePrompt, setEnablePrompt] = useState<{ id: string; name: string } | null>(null);
  // Full-page plugin detail navigation (replaces the card grid; back returns).
  // `configMode` scrolls straight to the Configuration section.
  const [detail, setDetail] = useState<{ id: string; configMode: boolean } | null>(null);
  const openDetail = (id: string, configMode = false) => setDetail({ id, configMode });
  const closeDetail = () => setDetail(null);

  // Gallery fetch is gated on visibility (the view stays mounted) and TTL-guarded
  // in the hooks, so opening costs nothing when the cached index is fresh.
  // Plugins refresh whenever the panel is shown; skins only once the Skins tab
  // has been opened while visible. Leaving the panel resets to the grid.
  const skinsFetched = useRef(false);
  useEffect(() => {
    if (!isVisible) { setDetail(null); return; }
    onFetchPluginGallery();
    if (tab === "skins" && !skinsFetched.current) {
      skinsFetched.current = true;
      onFetchSkinGallery();
    }
  }, [isVisible, tab]);

  const switchTab = (next: ExtTab) => { setDetail(null); setTab(next); };

  const kindFilter = tab === "skins" ? "skin" : "plugin";

  const filtered = useMemo(() => {
    let items = allExtensions.filter((e) => e.kind === kindFilter);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      items = items.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q) ||
          e.author.toLowerCase().includes(q),
      );
    }
    return items;
  }, [allExtensions, kindFilter, searchQuery]);

  const byName = (a: ExtensionItem, b: ExtensionItem) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

  const installedItems = filtered
    .filter((e) => e.status !== "not_installed")
    .sort(byName);

  // In-app discovery prefers the curated "recommended" subset (the long tail
  // lives on the site, "Browse all"). When the gallery index flags none as
  // recommended, fall back to showing everything available so the section is
  // never empty — the title reflects which set is shown.
  const available = filtered.filter((e) => e.status === "not_installed");
  const recommendedOnly = available.filter((e) => e.recommended);
  const discover = (recommendedOnly.length > 0 ? recommendedOnly : available).slice().sort(byName);
  const discoverTitle = recommendedOnly.length > 0 ? "Recommended" : "Available";

  const detailExt = detail ? allExtensions.find((e) => e.id === detail.id && e.kind === "plugin") || null : null;
  // If the open plugin disappears (e.g. uninstalled from its detail page), drop
  // back to the grid instead of showing an empty pane.
  useEffect(() => { if (detail && !detailExt) setDetail(null); }, [detail, detailExt]);

  const skinUpdateCount = allExtensions.filter((e) => e.kind === "skin" && e.updateAvailable?.status === "available").length;
  const pluginUpdateCount = allExtensions.filter((e) => e.kind === "plugin" && e.updateAvailable?.status === "available").length;

  const galleryLoading = tab === "skins" ? skinGalleryLoading : pluginGalleryLoading;
  const galleryError = tab === "skins" ? skinGalleryError : pluginGalleryError;
  const retryGallery = tab === "skins" ? onFetchSkinGallery : onFetchPluginGallery;
  const showGallerySkeleton = !!galleryLoading && discover.length === 0 && !searchQuery;
  const showGalleryError = !galleryLoading && !!galleryError && discover.length === 0;

  const browseAll = (
    <button
      type="button"
      className="ext-browse-all"
      onClick={() => openUrl(tab === "skins" ? LINKS.skinsPage : LINKS.pluginsPage).catch(console.error)}
    >
      Browse all ↗
    </button>
  );

  const handleInstall = async (ext: ExtensionItem) => {
    const entry =
      ext.kind === "plugin"
        ? galleryPlugins.find((p) => p.id === ext.id)
        : gallerySkins.find((s) => s.id === ext.id);
    if (!entry) return;
    const res = await onInstallFromGallery(entry);
    if (res.ok && res.kind === "plugin") setEnablePrompt({ id: ext.id, name: ext.name });
  };

  const submitUrl = () => {
    const url = urlValue.trim();
    if (!url) return;
    setUrlInstalling(true);
    onInstallFromUrl(url).finally(() => {
      setUrlInstalling(false);
      setUrlValue("");
      setShowUrlInput(false);
    });
  };

  return (
    <div className="extensions-view" style={style}>
      <div className="ext-topbar">
        <input
          className="ds-search"
          type="text"
          placeholder={`Search ${tab}…`}
          value={searchQuery}
          onChange={(e) => onSetSearchQuery(e.target.value)}
        />
        <div className="ext-topbar-actions">
          {updateCount > 0 && (
            <>
              <span className="ext-update-count">{updateCount} update{updateCount !== 1 ? "s" : ""}</span>
              <button className="ds-btn ds-btn--primary ds-btn--sm" onClick={onUpdateAll}>Update all</button>
            </>
          )}
          <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={onCheckForUpdates} disabled={checking}>
            {checking ? "Checking…" : "Check for updates"}
          </button>
          <button className="ds-btn ds-btn--ghost ds-btn--sm" onClick={() => setShowUrlInput((v) => !v)}>
            Install from URL
          </button>
        </div>
      </div>

      {showUrlInput && (
        <div className="ext-url-bar">
          <input
            className="ds-input"
            type="text"
            placeholder="GitHub URL or zip URL…"
            value={urlValue}
            onChange={(e) => setUrlValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitUrl(); }}
            autoFocus
          />
          <button className="ds-btn ds-btn--primary ds-btn--sm" disabled={urlInstalling || !urlValue.trim()} onClick={submitUrl}>
            {urlInstalling ? "Installing…" : "Install"}
          </button>
        </div>
      )}

      <div className="ds-tabs ds-tabs--no-border ext-filter-tabs">
        <button className={`ds-tab ${tab === "plugins" ? "active" : ""}`} onClick={() => switchTab("plugins")}>
          Plugins
          {pluginUpdateCount > 0 && <span className="ds-tab-badge">{pluginUpdateCount}</span>}
        </button>
        <button className={`ds-tab ${tab === "skins" ? "active" : ""}`} onClick={() => switchTab("skins")}>
          Skins
          {skinUpdateCount > 0 && <span className="ds-tab-badge">{skinUpdateCount}</span>}
        </button>
      </div>

      {tab === "plugins" ? (
        detailExt ? (
          <div className="ext-detail-full">
            <button type="button" className="ext-back" onClick={closeDetail}>
              <span aria-hidden="true">←</span> Back
            </button>
            <PluginDetail
              ext={detailExt}
              installing={installing.has(detailExt.id)}
              autoScrollToConfig={detail?.configMode}
              onUpdate={() => onUpdateExtension(detailExt.id)}
              onUninstall={() => onUninstall(detailExt.id, "plugin")}
              onToggleEnabled={() => onToggleEnabled(detailExt.id, "plugin")}
              onInstall={() => handleInstall(detailExt)}
              getPluginViewData={getPluginViewData}
              onPluginAction={onPluginAction}
            />
          </div>
        ) : (
          <div className="ext-plugins-pane">
            <SectionHeader title="Installed" count={installedItems.length} />
            <div className="ext-plugin-grid">
              {installedItems.map((ext) => (
                <PluginCard
                  key={ext.id}
                  ext={ext}
                  installing={installing.has(ext.id)}
                  onDetails={() => openDetail(ext.id)}
                  onConfig={() => openDetail(ext.id, true)}
                  onToggleEnabled={() => onToggleEnabled(ext.id, "plugin")}
                  onInstall={() => handleInstall(ext)}
                />
              ))}
            </div>

            <SectionHeader title={discoverTitle} count={discover.length} action={browseAll} />
            <div className="ext-plugin-grid">
              {discover.map((ext) => (
                <PluginCard
                  key={ext.id}
                  ext={ext}
                  installing={installing.has(ext.id)}
                  onDetails={() => openDetail(ext.id)}
                  onConfig={() => openDetail(ext.id, true)}
                  onToggleEnabled={() => onToggleEnabled(ext.id, "plugin")}
                  onInstall={() => handleInstall(ext)}
                />
              ))}
            </div>

            {showGallerySkeleton && (
              <div className="ext-plugin-grid">
                <PluginCardSkeleton /><PluginCardSkeleton /><PluginCardSkeleton />
              </div>
            )}
            {showGalleryError && <GalleryError onRetry={retryGallery} />}
            {!galleryLoading && !galleryError && filtered.length === 0 && (
              <div className="ext-empty">No plugins found</div>
            )}
          </div>
        )
      ) : (
        <div className="ext-skins-pane">
          <SectionHeader title="Installed" count={installedItems.length} />
          <div className="ext-skin-grid">
            {installedItems.map((ext) => (
              <SkinCard
                key={ext.id}
                ext={ext}
                installing={installing.has(ext.id)}
                onApply={() => onToggleEnabled(ext.id, "skin")}
                onInstall={() => handleInstall(ext)}
                onPreview={() => onPreviewSkin?.(ext.id)}
                onClearPreview={() => onPreviewSkin?.(null)}
              />
            ))}
          </div>

          <SectionHeader title={discoverTitle} count={discover.length} action={browseAll} />
          <div className="ext-skin-grid">
            {discover.map((ext) => (
              <SkinCard
                key={ext.id}
                ext={ext}
                installing={installing.has(ext.id)}
                onApply={() => onToggleEnabled(ext.id, "skin")}
                onInstall={() => handleInstall(ext)}
                onPreview={() => onPreviewSkin?.(ext.id)}
                onClearPreview={() => onPreviewSkin?.(null)}
              />
            ))}
          </div>

          {showGallerySkeleton && (
            <div className="ext-skin-grid">
              <SkinCardSkeleton /><SkinCardSkeleton /><SkinCardSkeleton /><SkinCardSkeleton />
            </div>
          )}
          {showGalleryError && <GalleryError onRetry={retryGallery} />}
          {!galleryLoading && !galleryError && filtered.length === 0 && (
            <div className="ext-empty">No skins found</div>
          )}
        </div>
      )}

      {enablePrompt && (
        <div className="ds-modal-overlay">
          <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="ds-modal-title">{enablePrompt.name} installed</h2>
            <p className="delete-confirm-warning">
              {enablePrompt.name} was installed but is disabled. Enable it now?
            </p>
            <div className="ds-modal-actions">
              <button className="ds-btn ds-btn--ghost" onClick={() => setEnablePrompt(null)}>Not now</button>
              <button
                className="ds-btn ds-btn--primary"
                autoFocus
                onClick={() => { const id = enablePrompt.id; setEnablePrompt(null); onToggleEnabled(id, "plugin"); }}
              >
                Enable
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
