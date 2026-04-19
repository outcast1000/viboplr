import React, { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { SearchProviderConfig } from "../searchProviders";
import { DEFAULT_PROVIDERS, getDomainFromUrl } from "../searchProviders";
import { IconGoogle, IconX, IconYoutube, IconGenius } from "./Icons";
import type { TimingEntry } from "../startupTiming";
import type { UpdateState } from "../hooks/useAppUpdater";
import type { SkinInfo, GallerySkinEntry } from "../types/skin";
import type { PluginState, PluginSettingsPanel, PluginViewData, GalleryPluginEntry } from "../types/plugin";
import { PluginViewRenderer } from "./PluginViewRenderer";
import { store } from "../store";
import "./SettingsPanel.css";

// Provider config data shapes from backend
interface InfoTypeRow {
  typeId: string;
  name: string;
  entity: string;
  displayKind: string;
  sortOrder: number;
  pluginId: string;
  priority: number;
  active: boolean;
}

interface ImageProviderRow {
  pluginId: string;
  entity: string;
  priority: number;
  active: boolean;
  id: number;
}

interface ProviderPillData {
  pluginId: string;
  priority: number;
  active: boolean;
  displayName: string;
}

interface ProviderRow {
  kind: "images" | "info";
  typeId: string;  // "images" for image rows, or the info type_id
  label: string;
  entity: string;
  sortOrder: number;
  providers: ProviderPillData[];
  hasLockedFirst: boolean; // true for album images (Embedded)
}

function parseProviderConfig(
  infoTypes: [string, string, string, string, number, string, number, boolean][],
  imageProviders: [string, string, number, boolean, number][],
  pluginStates?: PluginState[],
): Map<string, ProviderRow[]> {
  const entityMap = new Map<string, ProviderRow[]>();

  // Look up display name from plugin manifest, fallback to plugin ID
  const pluginNameMap = new Map<string, string>();
  if (pluginStates) {
    for (const ps of pluginStates) {
      pluginNameMap.set(ps.id, ps.manifest.name);
    }
  }
  function displayName(pluginId: string): string {
    return pluginNameMap.get(pluginId) ?? pluginId;
  }

  // Group image providers by entity
  const imagesByEntity = new Map<string, ImageProviderRow[]>();
  for (const [pluginId, entity, priority, active, id] of imageProviders) {
    if (!imagesByEntity.has(entity)) imagesByEntity.set(entity, []);
    imagesByEntity.get(entity)!.push({ pluginId, entity, priority, active, id });
  }

  // Group info types by entity and typeId
  const infoByEntity = new Map<string, Map<string, { name: string; sortOrder: number; providers: InfoTypeRow[] }>>();
  for (const [typeId, name, entity, displayKind, sortOrder, pluginId, priority, active] of infoTypes) {
    if (!infoByEntity.has(entity)) infoByEntity.set(entity, new Map());
    const entityTypes = infoByEntity.get(entity)!;
    if (!entityTypes.has(typeId)) entityTypes.set(typeId, { name, sortOrder, providers: [] });
    entityTypes.get(typeId)!.providers.push({ typeId, name, entity, displayKind, sortOrder, pluginId, priority, active });
  }

  // Collect all entities
  const allEntities = new Set<string>();
  for (const entity of imagesByEntity.keys()) allEntities.add(entity);
  for (const entity of infoByEntity.keys()) allEntities.add(entity);

  // Entity display order
  const entityOrder: Record<string, number> = { artist: 0, album: 1, track: 2, tag: 3 };

  for (const entity of [...allEntities].sort((a, b) => (entityOrder[a] ?? 99) - (entityOrder[b] ?? 99))) {
    const rows: ProviderRow[] = [];

    // Image providers row
    const imgs = imagesByEntity.get(entity);
    if (imgs && imgs.length > 0) {
      const sorted = [...imgs].sort((a, b) => a.priority - b.priority);
      rows.push({
        kind: "images",
        typeId: "images",
        label: "Images",
        entity,
        sortOrder: -1, // images first
        providers: sorted.map(ip => ({
          pluginId: ip.pluginId,
          priority: ip.priority,
          active: ip.active,
          displayName: displayName(ip.pluginId),
        })),
        hasLockedFirst: entity === "album",
      });
    }

    // Info type rows
    const types = infoByEntity.get(entity);
    if (types) {
      for (const [typeId, data] of types) {
        const sorted = [...data.providers].sort((a, b) => a.priority - b.priority);
        rows.push({
          kind: "info",
          typeId,
          label: data.name,
          entity,
          sortOrder: data.sortOrder,
          providers: sorted.map(ip => ({
            pluginId: ip.pluginId,
            priority: ip.priority,
            active: ip.active,
            displayName: displayName(ip.pluginId),
          })),
          hasLockedFirst: false,
        });
      }
    }

    // Sort: images first, then by sortOrder
    rows.sort((a, b) => a.sortOrder - b.sortOrder);
    entityMap.set(entity, rows);
  }

  return entityMap;
}

function ProviderPrioritySection({
  pluginStates,
  onFallbackOrderChanged,
}: {
  pluginStates?: PluginState[];
  onFallbackOrderChanged?: () => void;
}) {
  const [entityData, setEntityData] = useState<Map<string, ProviderRow[]>>(new Map());
  const [collapsedEntities, setCollapsedEntities] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [fallbackProviders, setFallbackProviders] = useState<Array<{ id: string; name: string; source: string; enabled: boolean }>>([]);

  // Manual mouse-event drag (HTML5 DnD is unreliable in WKWebView with user-select:none)
  const dragRef = useRef<{
    entity: string;
    row: ProviderRow;
    sourceIndex: number;
  } | null>(null);
  const dragOverIndexRef = useRef<number | null>(null);
  const didDragRef = useRef(false);
  const ghostRef = useRef<HTMLDivElement | null>(null);

  const fetchConfig = useCallback(async () => {
    try {
      const [infoTypes, imageProviders] = await invoke<[
        [string, string, string, string, number, string, number, boolean][],
        [string, string, number, boolean, number][],
      ]>("get_all_provider_config");
      setEntityData(parseProviderConfig(infoTypes, imageProviders, pluginStates));
    } catch (e) {
      console.error("Failed to fetch provider config:", e);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginStates]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  useEffect(() => {
    const loadFallback = async () => {
      const storedOrder = await store.get<Array<{ id: string; enabled: boolean }>>("fallbackProviderOrder");

      // Build provider list: built-in Library + plugin providers
      const allProviders: Array<{ id: string; name: string; source: string }> = [
        { id: "built-in:library", name: "Library", source: "Built-in" },
      ];
      if (pluginStates) {
        for (const ps of pluginStates) {
          if (ps.status !== "active") continue;
          const fps = ps.manifest.contributes?.fallbackProviders;
          if (!fps) continue;
          for (const fp of fps) {
            allProviders.push({
              id: `${ps.id}:${fp.id}`,
              name: fp.name,
              source: ps.manifest.name,
            });
          }
        }
      }

      if (storedOrder) {
        const ordered: typeof fallbackProviders = [];
        for (const entry of storedOrder) {
          const provider = allProviders.find((p) => p.id === entry.id);
          if (provider) ordered.push({ ...provider, enabled: entry.enabled });
        }
        // Append new providers not in stored order
        for (const provider of allProviders) {
          if (!ordered.some((p) => p.id === provider.id)) {
            ordered.push({ ...provider, enabled: true });
          }
        }
        setFallbackProviders(ordered);
      } else {
        setFallbackProviders(allProviders.map((p) => ({ ...p, enabled: true })));
      }
    };
    loadFallback();
  }, [pluginStates]);

  const toggleEntity = (entity: string) => {
    setCollapsedEntities(prev => {
      const next = new Set(prev);
      if (next.has(entity)) next.delete(entity);
      else next.add(entity);
      return next;
    });
  };

  const handleToggleActive = async (row: ProviderRow, provider: ProviderPillData) => {
    const newActive = !provider.active;
    try {
      if (row.kind === "images") {
        await invoke("update_image_provider_active", {
          pluginId: provider.pluginId,
          entity: row.entity,
          active: newActive,
        });
      } else {
        await invoke("update_info_type_active", {
          typeId: row.typeId,
          pluginId: provider.pluginId,
          active: newActive,
        });
      }
      await fetchConfig();
    } catch (e) {
      console.error("Failed to toggle active:", e);
    }
  };

  const applyReorder = async (row: ProviderRow, sourceIndex: number, targetIndex: number) => {
    if (sourceIndex === targetIndex) return;
    const providers = [...row.providers];
    const [moved] = providers.splice(sourceIndex, 1);
    providers.splice(targetIndex, 0, moved);

    const updates: Promise<void>[] = [];
    for (let i = 0; i < providers.length; i++) {
      const newPriority = (i + 1) * 100;
      if (providers[i].priority !== newPriority) {
        if (row.kind === "images") {
          updates.push(
            invoke("update_image_provider_priority", {
              pluginId: providers[i].pluginId,
              entity: row.entity,
              priority: newPriority,
            }) as Promise<void>,
          );
        } else {
          updates.push(
            invoke("update_info_type_priority", {
              typeId: row.typeId,
              pluginId: providers[i].pluginId,
              priority: newPriority,
            }) as Promise<void>,
          );
        }
      }
    }

    try {
      await Promise.all(updates);
      await fetchConfig();
    } catch (e) {
      console.error("Failed to update priorities:", e);
    }
  };

  const handlePillMouseDown = (
    e: React.MouseEvent,
    entity: string,
    row: ProviderRow,
    index: number,
    displayName: string,
  ) => {
    if (e.button !== 0) return;
    dragRef.current = { entity, row, sourceIndex: index };
    dragOverIndexRef.current = null;
    didDragRef.current = false;

    function findPillIndex(el: Element | null): number | null {
      while (el) {
        const idx = el.getAttribute("data-pill-index");
        if (idx !== null) return parseInt(idx, 10);
        el = el.parentElement;
      }
      return null;
    }

    function showGhost(x: number, y: number) {
      if (!ghostRef.current) {
        const ghost = document.createElement("div");
        ghost.className = "provider-pill-ghost";
        ghost.textContent = displayName;
        document.body.appendChild(ghost);
        ghostRef.current = ghost;
      }
      ghostRef.current.style.left = `${x + 12}px`;
      ghostRef.current.style.top = `${y - 10}px`;
    }

    function removeGhost() {
      if (ghostRef.current) {
        ghostRef.current.remove();
        ghostRef.current = null;
      }
    }

    function onMouseMove(ev: MouseEvent) {
      if (!dragRef.current) return;
      if (!didDragRef.current) {
        didDragRef.current = true;
      }
      showGhost(ev.clientX, ev.clientY);
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const overIdx = target ? findPillIndex(target) : null;
      dragOverIndexRef.current = overIdx;
    }

    function onMouseUp() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      removeGhost();
      const drag = dragRef.current;
      const targetIdx = dragOverIndexRef.current;
      if (didDragRef.current && drag && targetIdx !== null && targetIdx !== drag.sourceIndex) {
        applyReorder(drag.row, drag.sourceIndex, targetIdx);
      }
      dragRef.current = null;
      dragOverIndexRef.current = null;
      setTimeout(() => { didDragRef.current = false; }, 0);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const saveFallbackOrder = async (providers: typeof fallbackProviders) => {
    setFallbackProviders(providers);
    await store.set(
      "fallbackProviderOrder",
      providers.map((p) => ({ id: p.id, enabled: p.enabled })),
    );
    onFallbackOrderChanged?.();
  };

  const handleFallbackToggle = (id: string) => {
    const updated = fallbackProviders.map((p) =>
      p.id === id ? { ...p, enabled: !p.enabled } : p,
    );
    saveFallbackOrder(updated);
  };

  const handleFallbackReorder = (sourceIndex: number, targetIndex: number) => {
    if (sourceIndex === targetIndex) return;
    const updated = [...fallbackProviders];
    const [moved] = updated.splice(sourceIndex, 1);
    updated.splice(targetIndex, 0, moved);
    saveFallbackOrder(updated);
  };

  const handleReset = async () => {
    // Build defaults from plugin manifests
    const imageDefaults: [string, string, number][] = [];
    const infoDefaults: [string, string, number][] = [];

    if (pluginStates) {
      for (const plugin of pluginStates) {
        const contributes = plugin.manifest.contributes;
        if (!contributes) continue;
        if (contributes.imageProviders) {
          for (const ip of contributes.imageProviders) {
            imageDefaults.push([plugin.id, ip.entity, ip.priority]);
          }
        }
        if (contributes.informationTypes) {
          for (const it of contributes.informationTypes) {
            infoDefaults.push([it.id, plugin.id, it.priority]);
          }
        }
      }
    }

    try {
      await invoke("reset_provider_priorities", {
        imageDefaults,
        infoDefaults,
      });
      await fetchConfig();
    } catch (e) {
      console.error("Failed to reset priorities:", e);
    }
  };

  const entityLabels: Record<string, string> = {
    artist: "Artist",
    album: "Album",
    track: "Track",
    tag: "Tag",
  };

  if (loading) {
    return (
      <div className="settings-group">
        <div className="settings-group-title">Provider Priority</div>
        <div style={{ color: "var(--text-secondary)", fontSize: "var(--fs-sm)", padding: "12px 0" }}>
          Loading...
        </div>
      </div>
    );
  }

  if (entityData.size === 0) {
    return null;
  }

  return (
    <div className="settings-group">
      <div className="settings-group-title">Provider Priority</div>
      <div className="provider-priority-container">
        {[...entityData.entries()].map(([entity, rows]) => (
          <div key={entity} className="provider-entity-group">
            <button
              className="provider-entity-header"
              onClick={() => toggleEntity(entity)}
            >
              <span className={`provider-entity-chevron${collapsedEntities.has(entity) ? "" : " open"}`}>
                {"\u25B8"}
              </span>
              <span className="provider-entity-label">{entityLabels[entity] ?? entity}</span>
            </button>
            {!collapsedEntities.has(entity) && (
              <div className="provider-entity-rows">
                {rows.map(row => {
                  const isMulti = row.providers.length > 1;
                  return (
                    <div key={`${row.kind}-${row.typeId}`} className="provider-priority-row">
                      <span className="provider-priority-label">{row.label}</span>
                      <div className="provider-priority-pills">
                        {row.hasLockedFirst && (
                          <>
                            <span className="provider-pill provider-pill-locked">
                              <span className="provider-pill-lock">{"\uD83D\uDD12"}</span>
                              Embedded
                            </span>
                            {row.providers.length > 0 && (
                              <span className="provider-pill-arrow">{"\u2192"}</span>
                            )}
                          </>
                        )}
                        {row.providers.map((provider, i) => (
                          <React.Fragment key={provider.pluginId}>
                            {i > 0 && (
                              <span className="provider-pill-arrow">{"\u2192"}</span>
                            )}
                            <span
                              className={`provider-pill${!provider.active ? " provider-pill-disabled" : ""}${isMulti ? " provider-pill-draggable" : ""}`}
                              data-pill-index={i}
                              onMouseDown={isMulti ? (e) => handlePillMouseDown(e, entity, row, i, provider.displayName) : undefined}
                              onClick={() => { if (!didDragRef.current) handleToggleActive(row, provider); }}
                              title={`${provider.displayName} (priority ${provider.priority})${!provider.active ? " - disabled" : ""}\nClick to ${provider.active ? "disable" : "enable"}`}
                            >
                              {isMulti && (
                                <span className="provider-pill-handle">{"\u2630"}</span>
                              )}
                              {provider.displayName}
                            </span>
                          </React.Fragment>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
        {fallbackProviders.length > 0 && (
          <div className="provider-entity-group">
            <button
              className="provider-entity-header"
              onClick={() => toggleEntity("__fallback")}
            >
              <span className={`provider-entity-chevron${collapsedEntities.has("__fallback") ? "" : " open"}`}>
                {"\u25B8"}
              </span>
              <span className="provider-entity-label">Playback Fallback</span>
            </button>
            {!collapsedEntities.has("__fallback") && (
              <div className="provider-entity-rows">
                <div className="provider-priority-row">
                  <span className="provider-priority-label">Source priority</span>
                  <div className="provider-priority-pills">
                    {fallbackProviders.map((fp, idx) => (
                      <React.Fragment key={fp.id}>
                        {idx > 0 && (
                          <span className="provider-pill-arrow">{"\u2192"}</span>
                        )}
                        <span
                          className={`provider-pill${fp.enabled ? "" : " provider-pill-disabled"}${fallbackProviders.length > 1 ? " provider-pill-draggable" : ""}`}
                          data-pill-index={idx}
                          onMouseDown={fallbackProviders.length > 1 ? (e) => {
                            if (e.button !== 0) return;
                            dragRef.current = { entity: "__fallback", row: { kind: "info", typeId: "__fallback", label: "Playback Fallback", entity: "__fallback", sortOrder: 0, providers: [], hasLockedFirst: false }, sourceIndex: idx };
                            dragOverIndexRef.current = null;
                            didDragRef.current = false;

                            const findPillIndex = (el: Element | null): number | null => {
                              while (el) {
                                const i = el.getAttribute("data-pill-index");
                                if (i !== null) return parseInt(i, 10);
                                el = el.parentElement;
                              }
                              return null;
                            };

                            const onMouseMove = (ev: MouseEvent) => {
                              if (!dragRef.current) return;
                              if (!didDragRef.current) didDragRef.current = true;
                              if (!ghostRef.current) {
                                const ghost = document.createElement("div");
                                ghost.className = "provider-pill-ghost";
                                ghost.textContent = fp.name;
                                document.body.appendChild(ghost);
                                ghostRef.current = ghost;
                              }
                              ghostRef.current.style.left = `${ev.clientX + 12}px`;
                              ghostRef.current.style.top = `${ev.clientY - 10}px`;
                              const target = document.elementFromPoint(ev.clientX, ev.clientY);
                              dragOverIndexRef.current = target ? findPillIndex(target) : null;
                            };

                            const onMouseUp = () => {
                              window.removeEventListener("mousemove", onMouseMove);
                              window.removeEventListener("mouseup", onMouseUp);
                              if (ghostRef.current) { ghostRef.current.remove(); ghostRef.current = null; }
                              const drag = dragRef.current;
                              const targetIdx = dragOverIndexRef.current;
                              if (didDragRef.current && drag && drag.entity === "__fallback" && targetIdx !== null && targetIdx !== drag.sourceIndex) {
                                handleFallbackReorder(drag.sourceIndex, targetIdx);
                              }
                              dragRef.current = null;
                              dragOverIndexRef.current = null;
                              setTimeout(() => { didDragRef.current = false; }, 0);
                            };

                            window.addEventListener("mousemove", onMouseMove);
                            window.addEventListener("mouseup", onMouseUp);
                          } : undefined}
                          onClick={() => {
                            if (!didDragRef.current) handleFallbackToggle(fp.id);
                          }}
                          title={`${fp.name} (${fp.source})${fp.enabled ? "" : " — disabled"}`}
                        >
                          {fallbackProviders.length > 1 && (
                            <span className="provider-pill-handle">{"\u2630"}</span>
                          )}
                          {fp.name}
                        </span>
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="settings-actions-row provider-priority-actions">
        <button className="ds-btn ds-btn--secondary" onClick={handleReset}>Reset to Defaults</button>
      </div>
    </div>
  );
}

const BUILTIN_ICONS: Record<string, (p: { size?: number }) => ReactNode> = {
  google: IconGoogle,

  x: IconX,
  youtube: IconYoutube,
  genius: IconGenius,
};

const iconProps = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

const navIcons = {
  general: <svg {...iconProps}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1.08z"/></svg>,
  providers: <svg {...iconProps}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
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
  downloadFormat: string;
  onDownloadFormatChange: (format: string) => void;
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
  // Plugins
  pluginStates?: PluginState[];
  onTogglePlugin?: (pluginId: string, enabled: boolean) => void;
  onReloadPlugin?: (pluginId: string) => void;
  onReloadAllPlugins?: () => void;
  onOpenPluginsFolder?: () => void;
  onDeletePlugin?: (pluginId: string) => void;
  galleryPlugins?: GalleryPluginEntry[];
  galleryPluginsLoading?: boolean;
  galleryPluginsError?: string | null;
  onFetchPluginGallery?: () => void;
  onInstallPluginFromGallery?: (entry: GalleryPluginEntry) => Promise<{ ok: boolean; error?: string }>;
  // Plugin settings panels
  pluginSettingsPanels?: PluginSettingsPanel[];
  getPluginViewData?: (pluginId: string, viewId: string) => PluginViewData | undefined;
  onPluginAction?: (pluginId: string, actionId: string, data?: unknown) => void;
  // Logging
  loggingEnabled: boolean;
  onLoggingEnabledChange: (enabled: boolean) => void;
  // Fallback provider ordering
  onFallbackOrderChanged?: () => void;
}

interface ProviderFormData {
  name: string;
  artistUrl: string;
  albumUrl: string;
  trackUrl: string;
}

type SettingsTab = "general" | "skins" | "plugins" | "providers" | "debug" | `plugin:${string}`;

export function SettingsPanel({
  searchProviders,
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
  downloadFormat,
  onDownloadFormatChange,
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
  pluginStates,
  onTogglePlugin,
  onReloadPlugin,
  onReloadAllPlugins,
  onOpenPluginsFolder,
  onDeletePlugin,
  galleryPlugins,
  galleryPluginsLoading,
  galleryPluginsError,
  onFetchPluginGallery,
  onInstallPluginFromGallery,
  pluginSettingsPanels,
  getPluginViewData,
  onPluginAction,
  loggingEnabled,
  onLoggingEnabledChange,
  onFallbackOrderChanged,
}: SettingsPanelProps) {
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<ProviderFormData>({ name: "", artistUrl: "", albumUrl: "", trackUrl: "" });
  const [searchProvidersCollapsed, setSearchProvidersCollapsed] = useState(false);
  const [appPaths, setAppPaths] = useState<{ profile: string; logs: string } | null>(null);
  const [profileName, setProfileName] = useState<string | null>(null);

  useEffect(() => {
    if ((settingsTab === "general" || settingsTab === "debug") && !appPaths) {
      invoke<[string, string]>("get_app_paths")
        .then(([profile, logs]) => setAppPaths({ profile, logs }))
        .catch(console.error);
    }
    if (settingsTab === "general" && profileName === null) {
      invoke<{ profileName: string }>("get_profile_info")
        .then(({ profileName }) => setProfileName(profileName))
        .catch(console.error);
    }
  }, [settingsTab, appPaths, profileName]);

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


  const skinsIcon = <svg {...iconProps}><circle cx="13.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12" r="1.5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.5-.7 1.5-1.5 0-.4-.1-.7-.4-1-.2-.3-.4-.6-.4-1 0-.8.7-1.5 1.5-1.5H16c3.3 0 6-2.7 6-6 0-5.5-4.5-9.5-10-9.5z"/></svg>;

  const pluginIcon = <svg {...iconProps}><path d="M20 8h-2.81a5.45 5.45 0 0 1-.19-1.57A3.44 3.44 0 0 0 13.56 3 3.44 3.44 0 0 0 10 6.43c0 .55.07 1.07.19 1.57H8a2 2 0 0 0-2 2v2.81c-.5-.12-1.02-.19-1.57-.19A3.44 3.44 0 0 0 1 16.06 3.44 3.44 0 0 0 4.43 19.5c.55 0 1.07-.07 1.57-.19V22a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2.69c.5.12 1.02.19 1.57.19A3.44 3.44 0 0 0 23 15.94a3.44 3.44 0 0 0-3.43-3.44c-.55 0-1.07.07-1.57.19V10a2 2 0 0 0-2-2z"/></svg>;

  const navItems: { key: SettingsTab; label: string; icon: ReactNode }[] = [
    { key: "general", label: "General", icon: navIcons.general },
    { key: "skins", label: "Skins", icon: skinsIcon },
    { key: "plugins", label: "Plugins", icon: pluginIcon },
    // Plugin-contributed settings panels
    ...(pluginSettingsPanels ?? []).map(sp => ({
      key: `plugin:${sp.pluginId}:${sp.id}` as SettingsTab,
      label: sp.label,
      icon: pluginIcon,
    })),
    { key: "providers", label: "Providers", icon: navIcons.providers },
    { key: "debug", label: "Debug", icon: navIcons.debug },
  ];

  return (
    <div className="settings-view">
      <div className="ds-tabs">
        {navItems.map(item => (
          <button
            key={item.key}
            className={`ds-tab ${settingsTab === item.key ? "active" : ""}`}
            onClick={() => {
              setSettingsTab(item.key);
              if (item.key === "debug") onFetchBackendTimings();
            }}
          >
            {item.label}
          </button>
        ))}
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
                  <div className="settings-group-title">Downloads</div>
                  <div className="settings-card">
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Download format</span>
                        <span className="settings-description">Preferred format for saving tracks</span>
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

                <div className="settings-group">
                  <div className="settings-group-title">Profile</div>
                  <div className="settings-card">
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Current profile</span>
                      </div>
                      <span className="settings-value">{profileName ?? ""}</span>
                    </div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Profile folder</span>
                        <span className="settings-description">{appPaths?.profile ?? ""}</span>
                      </div>
                      <div className="settings-row-actions">
                        <button className="ds-btn ds-btn--secondary" onClick={() => appPaths && navigator.clipboard.writeText(appPaths.profile).catch(console.error)} title="Copy path">Copy</button>
                        <button className="ds-btn ds-btn--secondary" onClick={() => invoke("open_profile_folder").catch(console.error)}>Open</button>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="settings-about-content">
                  <div className="settings-about-logo" style={{ cursor: "pointer" }} onClick={() => openUrl("https://viboplr.com")}>
                    <svg width="48" height="48" viewBox="0 0 512 512" fill="none">
                      <defs><linearGradient id="aboutVGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#FF6B6B"/><stop offset="100%" stopColor="#E91E8A"/></linearGradient></defs>
                      <circle cx="256" cy="256" r="230" fill="none" stroke="url(#aboutVGrad)" strokeWidth="6" opacity="0.15"/>
                      <circle cx="256" cy="256" r="190" fill="none" stroke="url(#aboutVGrad)" strokeWidth="4" opacity="0.1"/>
                      <path d="M120,110 L256,400 L392,110" fill="none" stroke="url(#aboutVGrad)" strokeWidth="56" strokeLinecap="round" strokeLinejoin="round"/>
                      <circle cx="256" cy="400" r="16" fill="url(#aboutVGrad)" opacity="0.6"/>
                    </svg>
                  </div>
                  <span className="settings-about-name">Viboplr</span>
                  <span className="settings-about-version">v{appVersion}</span>
                  <a href="#" className="settings-about-link" onClick={(e) => { e.preventDefault(); openUrl("https://viboplr.com"); }}>viboplr.com</a>

                  {updateState.available && !updateState.downloading && (
                    <div className="update-available">
                      <span className="update-version">v{updateState.available.version} available</span>
                      {updateState.available.body && (
                        <p className="update-notes">{updateState.available.body}</p>
                      )}
                      <button className="ds-btn ds-btn--primary update-install-btn" onClick={onInstallUpdate}>
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
                        className="ds-btn ds-btn--secondary"
                        onClick={onCheckForUpdates}
                        disabled={updateState.checking}
                      >
                        {updateState.checking ? "Checking..." : "Check for Updates"}
                      </button>
                    </>
                  )}
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
                    <button className="ds-btn ds-btn--secondary" onClick={onImportSkin}>Import from file...</button>
                    <button className="ds-btn ds-btn--secondary" onClick={onFetchGallery}>Browse Gallery</button>
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
                          <button className="ds-btn ds-btn--secondary" style={{ marginLeft: 10 }} onClick={onFetchGallery}>Retry</button>
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

            {settingsTab === "plugins" && (
              <div className="settings-group">
                <div className="settings-group-title">Installed Plugins</div>
                {(!pluginStates || pluginStates.length === 0) ? (
                  <div className="settings-row" style={{ color: "var(--text-secondary)" }}>
                    No plugins installed. Add plugin folders to your plugins directory.
                  </div>
                ) : (
                  pluginStates.map(plugin => (
                    <div key={plugin.id} className="settings-row" style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0" }}>
                      <button
                        className={`toggle-switch${plugin.enabled ? " toggle-switch-on" : ""}`}
                        onClick={() => onTogglePlugin?.(plugin.id, !plugin.enabled)}
                      >
                        <span className="toggle-switch-thumb" />
                      </button>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 500 }}>
                          {plugin.manifest.name}
                          <span style={{ fontSize: "var(--fs-2xs)", color: "var(--text-secondary)", marginLeft: 6 }}>
                            v{plugin.manifest.version}
                          </span>
                          {plugin.builtin && (
                            <span style={{ fontSize: "var(--fs-2xs)", color: "var(--text-secondary)", marginLeft: 6, opacity: 0.7 }}>
                              Built-in
                            </span>
                          )}
                        </div>
                        {plugin.manifest.description && (
                          <div style={{ fontSize: "var(--fs-2xs)", color: "var(--text-secondary)" }}>
                            {plugin.manifest.description}
                          </div>
                        )}
                        {plugin.status === "error" && plugin.error && (
                          <div style={{ fontSize: "var(--fs-2xs)", color: "var(--error, #e55)" }}>
                            Error: {plugin.error}
                          </div>
                        )}
                        {plugin.status === "incompatible" && (
                          <div style={{ fontSize: "var(--fs-2xs)", color: "var(--warning, #ea5)" }}>
                            Incompatible with this version
                          </div>
                        )}
                      </div>
                      <button
                        className="skin-install-btn"
                        onClick={() => onReloadPlugin?.(plugin.id)}
                        title="Reload plugin"
                      >
                        Reload
                      </button>
                      {!plugin.builtin && onDeletePlugin && (
                        <button
                          className="skin-install-btn"
                          onClick={() => onDeletePlugin(plugin.id)}
                          title="Delete plugin"
                          style={{ color: "var(--error, #e55)" }}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  ))
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  {onOpenPluginsFolder && (
                    <button className="skin-install-btn" onClick={onOpenPluginsFolder}>
                      Open Plugins Folder
                    </button>
                  )}
                  {onReloadAllPlugins && (
                    <button className="skin-install-btn" onClick={onReloadAllPlugins}>
                      Reload All
                    </button>
                  )}
                  {onFetchPluginGallery && (
                    <button className="skin-install-btn" onClick={onFetchPluginGallery}>
                      Browse Gallery
                    </button>
                  )}
                </div>

                {((galleryPlugins && galleryPlugins.length > 0) || galleryPluginsLoading || galleryPluginsError) && (
                  <div style={{ marginTop: 16 }}>
                    <div className="settings-group-title" style={{ marginTop: 0 }}>Gallery</div>
                    {galleryPluginsLoading && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-secondary)", fontSize: "var(--fs-xs)", padding: "12px 0" }}>
                        <svg width="16" height="16" viewBox="0 0 16 16" style={{ animation: "status-spin 1s linear infinite" }}>
                          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" />
                        </svg>
                        Loading gallery...
                      </div>
                    )}
                    {galleryPluginsError && (
                      <div style={{ color: "var(--error)", fontSize: "var(--fs-xs)" }}>
                        {galleryPluginsError}
                        <button className="ds-btn ds-btn--secondary" style={{ marginLeft: 10 }} onClick={onFetchPluginGallery}>Retry</button>
                      </div>
                    )}
                    {!galleryPluginsLoading && !galleryPluginsError && galleryPlugins && galleryPlugins.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {galleryPlugins.map(entry => {
                          const installed = pluginStates?.find(p => p.id === entry.id);
                          return (
                            <div key={entry.id} className="settings-row" style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0" }}>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 500 }}>
                                  {entry.name}
                                  <span style={{ fontSize: "var(--fs-2xs)", color: "var(--text-secondary)", marginLeft: 6 }}>
                                    v{entry.version}
                                  </span>
                                  {entry.author && (
                                    <span style={{ fontSize: "var(--fs-2xs)", color: "var(--text-secondary)", marginLeft: 6 }}>
                                      by {entry.author}
                                    </span>
                                  )}
                                </div>
                                {entry.description && (
                                  <div style={{ fontSize: "var(--fs-2xs)", color: "var(--text-secondary)" }}>
                                    {entry.description}
                                  </div>
                                )}
                              </div>
                              {installed ? (
                                <span style={{ fontSize: "var(--fs-2xs)", color: "var(--text-secondary)", padding: "4px 8px" }}>
                                  Installed
                                </span>
                              ) : (
                                <button
                                  className="skin-install-btn"
                                  onClick={() => onInstallPluginFromGallery?.(entry)}
                                >
                                  Install
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {settingsTab === "providers" && (
                <>
                  <div className="settings-group">
                    <button
                      className="settings-group-title settings-group-title-collapsible"
                      onClick={() => setSearchProvidersCollapsed(!searchProvidersCollapsed)}
                    >
                      <span className={`provider-entity-chevron${searchProvidersCollapsed ? "" : " open"}`}>
                        {"\u25B8"}
                      </span>
                      Search Providers
                    </button>
                    {!searchProvidersCollapsed && (
                      <>
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
                                <button className="ds-btn ds-btn--secondary" onClick={cancelEdit}>Cancel</button>
                                <button className="ds-btn ds-btn--primary" onClick={saveEdit}>Save</button>
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
                              <button className="ds-btn ds-btn--secondary" onClick={startAdd}>+ Add Provider</button>
                              <button className="ds-btn ds-btn--secondary" onClick={resetToDefaults}>Reset to Defaults</button>
                            </div>
                          </>
                        )}
                      </>
                    )}
                  </div>

                  <ProviderPrioritySection pluginStates={pluginStates} onFallbackOrderChanged={onFallbackOrderChanged} />
                </>
            )}

            {settingsTab === "debug" && (
              <div className="settings-group">
                <div className="settings-group-title">Logging</div>
                <div className="settings-card">
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <span className="settings-label">Enable logging</span>
                      <span className="settings-description">Write exceptions, web requests, and performance data to a log file (requires restart)</span>
                    </div>
                    <ToggleSwitch checked={loggingEnabled} onChange={onLoggingEnabledChange} />
                  </div>
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <span className="settings-label">Log files</span>
                      <span className="settings-description">{appPaths?.logs ?? ""}</span>
                    </div>
                    <div className="settings-row-actions">
                      <button className="ds-btn ds-btn--secondary" onClick={() => appPaths && navigator.clipboard.writeText(appPaths.logs).catch(console.error)} title="Copy path">Copy</button>
                      <button className="ds-btn ds-btn--secondary" onClick={() => invoke("open_logs_folder").catch(console.error)}>Open</button>
                    </div>
                  </div>
                </div>
                <div className="settings-group-title" style={{ marginTop: 20 }}>Maintenance</div>
                <div className="settings-card">
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <span className="settings-label">Image cache</span>
                      <span className="settings-description">Retry previously failed image downloads</span>
                    </div>
                    <button className="ds-btn ds-btn--secondary" onClick={onClearImageFailures}>Retry</button>
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
                          <button className="ds-btn ds-btn--secondary" onClick={onSeedDatabase}>Seed</button>
                          <button className="ds-btn ds-btn--secondary" onClick={onClearDatabase} disabled={clearing}>
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

            {/* Plugin-contributed settings panels */}
            {settingsTab.startsWith("plugin:") && (() => {
              const parts = settingsTab.split(":");
              const pluginId = parts[1];
              const viewId = parts.slice(2).join(":");
              const data = getPluginViewData?.(pluginId, viewId);
              return (
                <div className="plugin-settings-panel">
                  <PluginViewRenderer
                    pluginName=""
                    data={data}
                    currentTrack={null}
                    onAction={(actionId, actionData) => onPluginAction?.(pluginId, actionId, actionData)}
                  />
                </div>
              );
            })()}
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
