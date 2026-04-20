import React, { useEffect, useMemo, useState } from "react";
import type {
  ExtensionItem,
  ExtensionUpdate,
  GalleryPluginEntry,
  PluginViewData,
} from "../types/plugin";
import type { GallerySkinEntry } from "../types/skin";
import { PluginViewRenderer } from "./PluginViewRenderer";

type ExtTab = "skins" | "plugins";

interface ExtensionsViewProps {
  allExtensions: ExtensionItem[];
  updateCount: number;
  selectedId: string | null;
  onSelectExtension: (id: string | null) => void;
  searchQuery: string;
  onSetSearchQuery: (q: string) => void;
  installing: Set<string>;
  checking: boolean;
  lastChecked: number | null;
  onCheckForUpdates: () => void;
  onUpdateExtension: (id: string) => void;
  onUpdateAll: () => void;
  onInstallFromGallery: (entry: GalleryPluginEntry | GallerySkinEntry) => void;
  onUninstall: (id: string, kind: "plugin" | "skin") => void;
  onToggleEnabled: (id: string, kind: "plugin" | "skin") => void;
  onFetchPluginGallery: () => void;
  onFetchSkinGallery: () => void;
  onInstallFromUrl: (url: string) => Promise<void>;
  galleryPlugins: GalleryPluginEntry[];
  gallerySkins: GallerySkinEntry[];
  getPluginViewData?: (pluginId: string, viewId: string) => PluginViewData | undefined;
  onPluginAction?: (pluginId: string, actionId: string, data?: unknown) => void;
}

function SkinIcon({ colors }: { colors: [string, string, string, string] }) {
  return (
    <div className="ext-icon ext-icon--skin">
      <div style={{ background: colors[0] }} />
      <div style={{ background: colors[1] }} />
      <div style={{ background: colors[2] }} />
      <div style={{ background: colors[3] }} />
    </div>
  );
}

function PluginIcon({ name, icon }: { name: string; icon?: string }) {
  if (icon) {
    return (
      <div className="ext-icon ext-icon--plugin">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d={icon} />
        </svg>
      </div>
    );
  }
  const letter = name.charAt(0).toUpperCase();
  return <div className="ext-icon ext-icon--plugin">{letter}</div>;
}

function StatusBadge({ status, update }: { status: string; update?: ExtensionUpdate }) {
  if (update) return <span className="ext-badge ext-badge--update">update</span>;
  switch (status) {
    case "active": return <span className="ext-badge ext-badge--active">active</span>;
    case "incompatible": return <span className="ext-badge ext-badge--error">incompatible</span>;
    case "error": return <span className="ext-badge ext-badge--error">error</span>;
    case "disabled": return <span className="ext-badge ext-badge--disabled">disabled</span>;
    default: return null;
  }
}

function ExtensionListItem({ ext, selected, onClick }: { ext: ExtensionItem; selected: boolean; onClick: () => void }) {
  return (
    <div
      className={`ext-list-item ${selected ? "ext-list-item--selected" : ""} ${ext.status === "not_installed" ? "ext-list-item--gallery" : ""}`}
      onClick={onClick}
    >
      {ext.kind === "skin" && ext.skinColors ? (
        <SkinIcon colors={ext.skinColors} />
      ) : (
        <PluginIcon name={ext.name} icon={ext.icon} />
      )}
      <div className="ext-list-item-info">
        <div className="ext-list-item-header">
          <span className="ext-list-item-name">{ext.name}</span>
          <StatusBadge status={ext.status} update={ext.updateAvailable} />
        </div>
        <div className="ext-list-item-desc">{ext.description}</div>
        <div className="ext-list-item-meta">
          {ext.author}
          {" \u00b7 "}
          {ext.updateAvailable
            ? `v${ext.version} \u2192 v${ext.updateAvailable.latestVersion}`
            : `v${ext.version}`}
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ title, count }: { title: string; count: number }) {
  if (count === 0) return null;
  return (
    <div className="ext-section-header">
      <span>{title}</span>
      <span className="ext-section-count">{count}</span>
    </div>
  );
}

function ExtensionDetail({
  ext, installing, onUpdate, onUninstall, onToggleEnabled, onInstallFromGallery, galleryPlugins, gallerySkins,
  getPluginViewData, onPluginAction,
}: {
  ext: ExtensionItem; installing: boolean; onUpdate: () => void; onUninstall: () => void;
  onToggleEnabled: () => void; onInstallFromGallery: (entry: GalleryPluginEntry | GallerySkinEntry) => void;
  galleryPlugins: GalleryPluginEntry[]; gallerySkins: GallerySkinEntry[];
  getPluginViewData?: (pluginId: string, viewId: string) => PluginViewData | undefined;
  onPluginAction?: (pluginId: string, actionId: string, data?: unknown) => void;
}) {
  const isInstalled = ext.status !== "not_installed";
  const [showSettings, setShowSettings] = useState(false);
  const settingsPanelId = ext.kind === "plugin" && ext.status === "active" && ext.contributes?.settingsPanel?.id;

  return (
    <div className="ext-detail">
      <div className="ext-detail-header">
        {ext.kind === "skin" && ext.skinColors ? (
          <SkinIcon colors={ext.skinColors} />
        ) : (
          <PluginIcon name={ext.name} icon={ext.icon} />
        )}
        <div className="ext-detail-header-info">
          <div className="ext-detail-name">{ext.name}</div>
          <div className="ext-detail-desc">{ext.description}</div>
          <div className="ext-detail-meta">
            By <strong>{ext.author}</strong> {"\u00b7"} v{ext.version} {"\u00b7"}{" "}
            {ext.kind === "plugin" ? "Plugin" : "Skin"}
            {isInstalled && (
              <>{" \u00b7 "}{ext.status === "active" ? "Enabled" : "Disabled"}</>
            )}
          </div>
        </div>
      </div>

      <div className="ext-detail-actions">
        {ext.updateAvailable && ext.updateAvailable.status === "available" && (
          <button className="ds-btn ds-btn--primary ds-btn--sm" onClick={onUpdate} disabled={installing}>
            {installing ? "Updating..." : `Update to v${ext.updateAvailable.latestVersion}`}
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
              <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={onUninstall}>Uninstall</button>
            )}
          </>
        )}
        {!isInstalled && (
          <button className="ds-btn ds-btn--primary ds-btn--sm" disabled={installing} onClick={() => {
            if (ext.kind === "plugin") {
              const entry = galleryPlugins.find((p) => p.id === ext.id);
              if (entry) onInstallFromGallery(entry);
            } else {
              const entry = gallerySkins.find((s) => s.id === ext.id);
              if (entry) onInstallFromGallery(entry);
            }
          }}>
            {installing ? "Installing..." : "Install"}
          </button>
        )}
        {settingsPanelId && (
          <button
            className={`ds-btn ds-btn--secondary ds-btn--sm${showSettings ? " active" : ""}`}
            onClick={() => setShowSettings(!showSettings)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
              <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
            Configure
          </button>
        )}
      </div>

      {showSettings && settingsPanelId && (
        <div className="ext-detail-settings">
          <PluginViewRenderer
            pluginName=""
            data={getPluginViewData?.(ext.id, settingsPanelId)}
            currentTrack={null}
            onAction={(actionId, actionData) => onPluginAction?.(ext.id, actionId, actionData)}
          />
        </div>
      )}

      {ext.updateAvailable && (
        <div className="ext-detail-update-box">
          <div className="ext-detail-update-title">Update Available: v{ext.updateAvailable.latestVersion}</div>
          {ext.updateAvailable.changelog && (
            <div className="ext-detail-update-changelog">{ext.updateAvailable.changelog}</div>
          )}
        </div>
      )}

      <div className="ext-detail-info">
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
          <span className="ext-detail-info-label">Type</span>
          <span>{ext.kind === "plugin" ? "Plugin" : "Skin"}</span>
          {ext.minAppVersion && (
            <>
              <span className="ext-detail-info-label">Min App Version</span>
              <span>{ext.minAppVersion}</span>
            </>
          )}
          <span className="ext-detail-info-label">Source</span>
          <span>{ext.source}</span>
          {ext.kind === "skin" && ext.skinType && (
            <>
              <span className="ext-detail-info-label">Theme</span>
              <span>{ext.skinType === "dark" ? "Dark" : "Light"}</span>
            </>
          )}
          {ext.contributes && (() => {
            const items: { category: string; names: string[] }[] = [];
            if (ext.contributes.informationTypes?.length)
              items.push({ category: "Info Types", names: ext.contributes.informationTypes.map(t => t.name) });
            if (ext.contributes.imageProviders?.length)
              items.push({ category: "Image Providers", names: ext.contributes.imageProviders.map(p => `${p.entity} images`) });
            if (ext.contributes.contextMenuItems?.length) {
              const byTarget = new Map<string, string[]>();
              for (const m of ext.contributes.contextMenuItems) {
                for (const t of m.targets) {
                  const list = byTarget.get(t) || [];
                  list.push(m.label);
                  byTarget.set(t, list);
                }
              }
              for (const [target, labels] of byTarget) {
                items.push({ category: `Menu (${target})`, names: labels });
              }
            }
            if (ext.contributes.sidebarItems?.length)
              items.push({ category: "Sidebar", names: ext.contributes.sidebarItems.map(s => s.label) });
            if (ext.contributes.eventHooks?.length)
              items.push({ category: "Event Hooks", names: ext.contributes.eventHooks });
            if (ext.contributes.fallbackProviders?.length)
              items.push({ category: "Fallback Playback Providers", names: ext.contributes.fallbackProviders.map(f => f.name) });
            if (ext.contributes.settingsPanel)
              items.push({ category: "Settings", names: [ext.contributes.settingsPanel.label] });
            if (!items.length) return null;
            return items.map(({ category, names }) => (
              <React.Fragment key={category}>
                <span className="ext-detail-info-label">{category}</span>
                <span>{names.join(", ")}</span>
              </React.Fragment>
            ));
          })()}
        </div>
      </div>

      {ext.apiUsage && ext.apiUsage.length > 0 && (
        <div className="ext-detail-api-usage">
          <div className="ext-detail-api-usage-title">API Usage</div>
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
    </div>
  );
}

export default function ExtensionsView(props: ExtensionsViewProps) {
  const {
    allExtensions,
    updateCount,
    selectedId,
    onSelectExtension,
    searchQuery,
    onSetSearchQuery,
    installing,
    checking,
    onCheckForUpdates,
    onUpdateExtension,
    onUpdateAll,
    onInstallFromGallery,
    onUninstall,
    onToggleEnabled,
    onFetchPluginGallery,
    onFetchSkinGallery,
    onInstallFromUrl,
    galleryPlugins,
    gallerySkins,
    getPluginViewData,
    onPluginAction,
  } = props;

  const [tab, setTab] = useState<ExtTab>("plugins");
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [urlValue, setUrlValue] = useState("");
  const [urlInstalling, setUrlInstalling] = useState(false);

  useEffect(() => {
    onFetchPluginGallery();
    onFetchSkinGallery();
  }, []);

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

  const active = filtered.filter((e) => e.status === "active");
  const installed = filtered.filter((e) => e.status !== "not_installed" && e.status !== "active");
  const available = filtered.filter((e) => e.status === "not_installed");

  const selectedExt = allExtensions.find((e) => e.id === selectedId) || null;

  const skinUpdateCount = allExtensions.filter((e) => e.kind === "skin" && e.updateAvailable?.status === "available").length;
  const pluginUpdateCount = allExtensions.filter((e) => e.kind === "plugin" && e.updateAvailable?.status === "available").length;

  return (
    <div className="extensions-view">
      <div className="ext-topbar">
        <input
          className="ds-search"
          type="text"
          placeholder={`Search ${tab}...`}
          value={searchQuery}
          onChange={(e) => onSetSearchQuery(e.target.value)}
        />
        <div className="ext-topbar-actions">
          {updateCount > 0 && (
            <>
              <span className="ext-update-count">{updateCount} update{updateCount !== 1 ? "s" : ""}</span>
              <button className="ds-btn ds-btn--primary ds-btn--sm" onClick={onUpdateAll}>Update All</button>
            </>
          )}
          <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={onCheckForUpdates} disabled={checking}>
            {checking ? "Checking..." : "Check for Updates"}
          </button>
          <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={() => setShowUrlInput(!showUrlInput)}>
            Install from URL
          </button>
        </div>
      </div>

      {showUrlInput && (
        <div className="ext-url-bar">
          <input
            className="ds-input"
            type="text"
            placeholder="GitHub URL or zip URL..."
            value={urlValue}
            onChange={(e) => setUrlValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && urlValue.trim()) {
                setUrlInstalling(true);
                onInstallFromUrl(urlValue.trim()).finally(() => {
                  setUrlInstalling(false);
                  setUrlValue("");
                  setShowUrlInput(false);
                });
              }
            }}
            autoFocus
          />
          <button
            className="ds-btn ds-btn--primary ds-btn--sm"
            disabled={urlInstalling || !urlValue.trim()}
            onClick={() => {
              if (!urlValue.trim()) return;
              setUrlInstalling(true);
              onInstallFromUrl(urlValue.trim()).finally(() => {
                setUrlInstalling(false);
                setUrlValue("");
                setShowUrlInput(false);
              });
            }}
          >
            {urlInstalling ? "Installing..." : "Install"}
          </button>
        </div>
      )}

      <div className="ds-tabs ds-tabs--no-border ext-filter-tabs">
        <button className={`ds-tab ${tab === "plugins" ? "active" : ""}`} onClick={() => setTab("plugins")}>
          Plugins
          {pluginUpdateCount > 0 && <span className="ds-tab-badge">{pluginUpdateCount}</span>}
        </button>
        <button className={`ds-tab ${tab === "skins" ? "active" : ""}`} onClick={() => setTab("skins")}>
          Skins
          {skinUpdateCount > 0 && <span className="ds-tab-badge">{skinUpdateCount}</span>}
        </button>
      </div>

      <div className="ext-content">
        <div className="ext-list">
          {filtered.length === 0 && (
            <div className="ext-empty">No {tab} found</div>
          )}

          <SectionHeader title="Active" count={active.length} />
          {active.map((ext) => (
            <ExtensionListItem key={`${ext.kind}-${ext.id}`} ext={ext} selected={selectedId === ext.id} onClick={() => onSelectExtension(ext.id)} />
          ))}

          <SectionHeader title="Installed" count={installed.length} />
          {installed.map((ext) => (
            <ExtensionListItem key={`${ext.kind}-${ext.id}`} ext={ext} selected={selectedId === ext.id} onClick={() => onSelectExtension(ext.id)} />
          ))}

          <SectionHeader title="Available" count={available.length} />
          {available.map((ext) => (
            <ExtensionListItem key={`${ext.kind}-${ext.id}`} ext={ext} selected={selectedId === ext.id} onClick={() => onSelectExtension(ext.id)} />
          ))}
        </div>

        <div className="ext-detail-pane">
          {selectedExt ? (
            <ExtensionDetail
              ext={selectedExt}
              installing={installing.has(selectedExt.id)}
              onUpdate={() => onUpdateExtension(selectedExt.id)}
              onUninstall={() => onUninstall(selectedExt.id, selectedExt.kind)}
              onToggleEnabled={() => onToggleEnabled(selectedExt.id, selectedExt.kind)}
              onInstallFromGallery={onInstallFromGallery}
              galleryPlugins={galleryPlugins}
              gallerySkins={gallerySkins}
              getPluginViewData={getPluginViewData}
              onPluginAction={onPluginAction}
            />
          ) : (
            <div className="ext-detail-empty">Select an extension to view details</div>
          )}
        </div>
      </div>
    </div>
  );
}
