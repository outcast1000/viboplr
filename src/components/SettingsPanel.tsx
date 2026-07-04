import React, { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
import type { TimingEntry } from "../startupTiming";
import type { UpdateState } from "../hooks/useAppUpdater";
import type { PluginState } from "../types/plugin";
import { LINKS } from "../constants/links";
import { ZOOM_PRESET_OPTIONS } from "../utils/zoom";
import { store } from "../store";
import { DEFAULT_INFO_TYPE_ORDER, DEFAULT_INFO_TYPE_PRIORITY, DEFAULT_IMAGE_PROVIDER_PRIORITY, DEFAULT_DOWNLOAD_PROVIDER_PRIORITY } from "../hooks/usePlugins";
import "./SettingsPanel.css";

// Modifier-key glyph for shortcut hints (⌘ on macOS, Ctrl elsewhere).
const MOD_KEY_LABEL =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
    ? "⌘"
    : "Ctrl";

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
  providerId?: string;
  priority: number;
  active: boolean;
  displayName: string;
}

interface ProviderRow {
  kind: "images" | "info" | "download";
  typeId: string;  // "images" for image rows, "download" for download rows, or the info type_id
  label: string;
  entity: string;
  sortOrder: number;
  providers: ProviderPillData[];
  hasLockedFirst: boolean; // true for album images (Embedded)
}

function parseProviderConfig(
  infoTypes: [string, string, string, string, number, string, number, boolean][],
  imageProviders: [string, string, number, boolean, number][],
  downloadProviders: [string, string, string, number, boolean][],
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

  // Filter out providers whose plugin is no longer installed. The backend
  // keeps `active = 0` rows around for plugins that are temporarily disabled
  // (so user settings persist across uninstall/reinstall), but rows for
  // plugins that no longer exist on disk would otherwise show up as dim
  // pills the user can't act on.
  const isInstalled = (pluginId: string) =>
    pluginStates ? pluginNameMap.has(pluginId) : true;

  // Group image providers by entity
  const imagesByEntity = new Map<string, ImageProviderRow[]>();
  for (const [pluginId, entity, priority, active, id] of imageProviders) {
    if (!isInstalled(pluginId)) continue;
    if (!imagesByEntity.has(entity)) imagesByEntity.set(entity, []);
    imagesByEntity.get(entity)!.push({ pluginId, entity, priority, active, id });
  }

  // Group info types by entity and typeId
  const infoByEntity = new Map<string, Map<string, { name: string; sortOrder: number; providers: InfoTypeRow[] }>>();
  for (const [typeId, name, entity, displayKind, sortOrder, pluginId, priority, active] of infoTypes) {
    if (!isInstalled(pluginId)) continue;
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

  // Download providers as a separate "download" entity group
  const installedDownloads = downloadProviders.filter(([pluginId]) => isInstalled(pluginId));
  if (installedDownloads.length > 0) {
    const sorted = [...installedDownloads].sort((a, b) => a[3] - b[3]);
    const dlRow: ProviderRow = {
      kind: "download",
      typeId: "download",
      label: "Source priority",
      entity: "download",
      sortOrder: 0,
      providers: sorted.map(([pluginId, providerId, name, priority, active]) => ({
        pluginId,
        providerId,
        priority,
        active,
        displayName: name,
      })),
      hasLockedFirst: false,
    };
    entityMap.set("download", [dlRow]);
  }

  return entityMap;
}

function ProviderPrioritySection({
  pluginStates,
  onStreamResolverOrderChanged,
}: {
  pluginStates?: PluginState[];
  onStreamResolverOrderChanged?: () => void;
}) {
  const [entityData, setEntityData] = useState<Map<string, ProviderRow[]>>(new Map());
  const [collapsedEntities, setCollapsedEntities] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [streamResolvers, setStreamResolvers] = useState<Array<{ id: string; name: string; source: string; enabled: boolean }>>([]);

  // Manual mouse-event drag (HTML5 DnD is unreliable in WKWebView with user-select:none)
  const didDragRef = useRef(false);
  const ghostRef = useRef<HTMLDivElement | null>(null);

  const fetchConfig = useCallback(async () => {
    try {
      const [infoTypes, imageProviders, downloadProviders] = await invoke<[
        [string, string, string, string, number, string, number, boolean][],
        [string, string, number, boolean, number][],
        [string, string, string, number, boolean][],
      ]>("get_all_provider_config");
      setEntityData(parseProviderConfig(infoTypes, imageProviders, downloadProviders, pluginStates));
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
    const loadStreamResolvers = async () => {
      const storedOrder = await store.get<Array<{ id: string; enabled: boolean }>>("streamResolverOrder");

      // Build provider list: built-in Library + plugin providers
      const allProviders: Array<{ id: string; name: string; source: string }> = [
        { id: "built-in:library", name: "Library", source: "Built-in" },
      ];
      if (pluginStates) {
        for (const ps of pluginStates) {
          if (ps.status !== "active") continue;
          const fps = ps.manifest.contributes?.streamResolvers;
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
        const ordered: typeof streamResolvers = [];
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
        setStreamResolvers(ordered);
      } else {
        setStreamResolvers(allProviders.map((p) => ({ ...p, enabled: true })));
      }
    };
    loadStreamResolvers();
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
      } else if (row.kind === "download") {
        await invoke("update_download_provider_active", {
          pluginId: provider.pluginId,
          providerId: provider.providerId,
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
        } else if (row.kind === "download") {
          updates.push(
            invoke("update_download_provider_priority", {
              pluginId: providers[i].pluginId,
              providerId: providers[i].providerId,
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

  // Generic vertical drag-to-reorder. Grabbed by a row's handle; reorders within
  // the row's own [data-vlist] container. `onReorder(from, to)` applies the move.
  const startRowDrag = (
    e: React.MouseEvent,
    sourceIndex: number,
    displayName: string,
    onReorder: (from: number, to: number) => void,
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const handle = e.currentTarget as HTMLElement;
    const sourceRow = handle.closest("[data-row-index]") as HTMLElement | null;
    const list = handle.closest("[data-vlist]") as HTMLElement | null;
    if (!sourceRow || !list) return;
    let overIndex: number | null = null;
    didDragRef.current = false;

    function findRowIndex(el: Element | null): number | null {
      while (el && el !== list) {
        const idx = el.getAttribute("data-row-index");
        if (idx !== null) return parseInt(idx, 10);
        el = el.parentElement;
      }
      return null;
    }

    function clearDropIndicators() {
      list!.querySelectorAll(".provider-vrow-drop-above, .provider-vrow-drop-below").forEach(el => {
        el.classList.remove("provider-vrow-drop-above", "provider-vrow-drop-below");
      });
    }

    function onMouseMove(ev: MouseEvent) {
      if (!didDragRef.current) {
        if (Math.abs(ev.clientX - startX) < 5 && Math.abs(ev.clientY - startY) < 5) return;
        didDragRef.current = true;
        sourceRow!.classList.add("provider-vrow-dragging");
      }
      if (!ghostRef.current) {
        const ghost = document.createElement("div");
        ghost.className = "provider-vrow-ghost";
        ghost.textContent = displayName;
        document.body.appendChild(ghost);
        ghostRef.current = ghost;
      }
      ghostRef.current.style.left = `${ev.clientX + 12}px`;
      ghostRef.current.style.top = `${ev.clientY - 10}px`;

      clearDropIndicators();
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const overIdx = list!.contains(target) ? findRowIndex(target) : null;
      overIndex = overIdx;
      if (overIdx !== null && overIdx !== sourceIndex) {
        const targetRow = list!.querySelector(`[data-row-index="${overIdx}"]`);
        if (targetRow) {
          targetRow.classList.add(overIdx < sourceIndex ? "provider-vrow-drop-above" : "provider-vrow-drop-below");
        }
      }
    }

    function onMouseUp() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (ghostRef.current) { ghostRef.current.remove(); ghostRef.current = null; }
      clearDropIndicators();
      sourceRow!.classList.remove("provider-vrow-dragging");
      if (didDragRef.current && overIndex !== null && overIndex !== sourceIndex) {
        onReorder(sourceIndex, overIndex);
      }
      setTimeout(() => { didDragRef.current = false; }, 0);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const saveStreamResolverOrder = async (providers: typeof streamResolvers) => {
    setStreamResolvers(providers);
    await store.set(
      "streamResolverOrder",
      providers.map((p) => ({ id: p.id, enabled: p.enabled })),
    );
    onStreamResolverOrderChanged?.();
  };

  const handleStreamResolverToggle = (id: string) => {
    const updated = streamResolvers.map((p) =>
      p.id === id ? { ...p, enabled: !p.enabled } : p,
    );
    saveStreamResolverOrder(updated);
  };

  const handleStreamResolverReorder = (sourceIndex: number, targetIndex: number) => {
    if (sourceIndex === targetIndex) return;
    const updated = [...streamResolvers];
    const [moved] = updated.splice(sourceIndex, 1);
    updated.splice(targetIndex, 0, moved);
    saveStreamResolverOrder(updated);
  };

  const handleReset = async () => {
    // Build defaults from plugin manifests
    const imageDefaults: [string, string, number][] = [];
    const infoDefaults: [string, string, number, number][] = [];
    const downloadDefaults: [string, string, string, number][] = [];

    if (pluginStates) {
      for (const plugin of pluginStates) {
        const contributes = plugin.manifest.contributes;
        if (!contributes) continue;
        if (contributes.imageProviders) {
          for (const ip of contributes.imageProviders) {
            const imgPriority = DEFAULT_IMAGE_PROVIDER_PRIORITY[`${plugin.id}:${ip.entity}`] ?? 999;
            imageDefaults.push([plugin.id, ip.entity, imgPriority]);
          }
        }
        if (contributes.informationTypes) {
          for (const it of contributes.informationTypes) {
            const priority = DEFAULT_INFO_TYPE_PRIORITY[it.id]?.[plugin.id] ?? 500;
            const order = DEFAULT_INFO_TYPE_ORDER[it.id] ?? 500;
            infoDefaults.push([it.id, plugin.id, priority, order]);
          }
        }
        if (contributes.downloadProviders) {
          for (const dp of contributes.downloadProviders) {
            const dlPriority = DEFAULT_DOWNLOAD_PROVIDER_PRIORITY[`${plugin.id}:${dp.id}`] ?? 999;
            downloadDefaults.push([plugin.id, dp.id, dp.name, dlPriority]);
          }
        }
      }
    }

    try {
      await invoke("reset_provider_priorities", {
        imageDefaults,
        infoDefaults,
      });
      if (downloadDefaults.length > 0) {
        await invoke("reset_download_provider_priorities", {
          defaults: downloadDefaults,
        });
      }
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

  const infoEntities = ["artist", "album", "track", "tag"];
  const infoEntries = [...entityData.entries()].filter(([entity]) => infoEntities.includes(entity));
  const downloadRow = entityData.get("download")?.[0] ?? null;

  // Shared renderer for one priority list (label + vertical, draggable providers).
  const renderProviderRow = (row: ProviderRow) => {
    const isMulti = row.providers.length > 1;
    return (
      <div key={`${row.kind}-${row.typeId}`} className="provider-priority-row">
        <span className="provider-priority-label">{row.label}</span>
        <div className="provider-vlist" data-vlist>
          {row.hasLockedFirst && (
            <div className="provider-vrow provider-vrow-locked" title="Embedded artwork is always tried first">
              <span className="provider-vrow-lock">{"🔒"}</span>
              <span className="provider-vrow-name">Embedded</span>
              <span className="provider-vrow-note">always first</span>
            </div>
          )}
          {row.providers.map((provider, i) => (
            <div
              key={provider.pluginId + (provider.providerId ?? "")}
              className={`provider-vrow${!provider.active ? " provider-vrow-off" : ""}`}
              data-row-index={i}
            >
              {isMulti && (
                <span
                  className="provider-vrow-handle"
                  onMouseDown={(e) => startRowDrag(e, i, provider.displayName, (from, to) => applyReorder(row, from, to))}
                  title="Drag to reorder"
                >{"⠿"}</span>
              )}
              {isMulti && <span className="provider-vrow-rank">{i + 1}</span>}
              <span className="provider-vrow-name">{provider.displayName}</span>
              <button
                type="button"
                className={`provider-switch${provider.active ? " on" : ""}`}
                role="switch"
                aria-checked={provider.active}
                onClick={() => handleToggleActive(row, provider)}
                title={provider.active ? "Enabled — click to disable" : "Disabled — click to enable"}
              />
            </div>
          ))}
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="settings-group">
        <div style={{ color: "var(--text-secondary)", fontSize: "var(--fs-sm)", padding: "12px 0" }}>
          Loading...
        </div>
      </div>
    );
  }

  return (
    <>
      {infoEntries.length > 0 && (
        <div className="settings-group">
          <div className="settings-group-title">Images &amp; Information</div>
          <div className="provider-priority-container">
            {infoEntries.map(([entity, rows]) => (
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
                    {rows.map(renderProviderRow)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {streamResolvers.length > 0 && (
        <div className="settings-group">
          <div className="settings-group-title">Streaming</div>
          <div className="provider-priority-container">
            <div className="provider-entity-group">
              <div className="provider-entity-rows">
                <div className="provider-priority-row">
                  <span className="provider-priority-label">Source priority</span>
                  <div className="provider-vlist" data-vlist>
                    {streamResolvers.map((fp, idx) => {
                      const isMulti = streamResolvers.length > 1;
                      return (
                        <div
                          key={fp.id}
                          className={`provider-vrow${fp.enabled ? "" : " provider-vrow-off"}`}
                          data-row-index={idx}
                        >
                          {isMulti && (
                            <span
                              className="provider-vrow-handle"
                              onMouseDown={(e) => startRowDrag(e, idx, fp.name, handleStreamResolverReorder)}
                              title="Drag to reorder"
                            >{"⠿"}</span>
                          )}
                          {isMulti && <span className="provider-vrow-rank">{idx + 1}</span>}
                          <span className="provider-vrow-name">{fp.name}</span>
                          <span className="provider-vrow-source">{fp.source}</span>
                          <button
                            type="button"
                            className={`provider-switch${fp.enabled ? " on" : ""}`}
                            role="switch"
                            aria-checked={fp.enabled}
                            onClick={() => handleStreamResolverToggle(fp.id)}
                            title={fp.enabled ? "Enabled — click to disable" : "Disabled — click to enable"}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {downloadRow && (
        <div className="settings-group">
          <div className="settings-group-title">Downloads</div>
          <div className="provider-priority-container">
            <div className="provider-entity-group">
              <div className="provider-entity-rows">
                {renderProviderRow(downloadRow)}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="settings-actions-row provider-priority-actions">
        <button className="ds-btn ds-btn--secondary" onClick={handleReset}>Reset to Defaults</button>
      </div>
    </>
  );
}

const iconProps = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

const navIcons = {
  general: <svg {...iconProps}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1.08z"/></svg>,
  providers: <svg {...iconProps}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
  search: <svg {...iconProps}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  debug: <svg {...iconProps}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>,
};

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={`ds-toggle ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
    >
      <span className="ds-toggle-thumb" />
    </button>
  );
}

function DependenciesSection({
  dependencies,
  autoUpdateManagedDeps,
  onAutoUpdateManagedDepsChange,
}: {
  dependencies?: SettingsPanelProps["dependencies"];
  autoUpdateManagedDeps: boolean;
  onAutoUpdateManagedDepsChange: (enabled: boolean) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [actioning, setActioning] = useState<string | null>(null);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  // Name of the dep whose inline "let Viboplr manage" confirm is open.
  const [takeoverConfirm, setTakeoverConfirm] = useState<string | null>(null);

  useEffect(() => {
    if (dependencies && dependencies.deps.length === 0) {
      // Offline presence check first, then the networked latest-version pass.
      dependencies.checkAll().then(() => dependencies.checkUpdates()).catch(console.error);
    }
  }, [dependencies]);

  if (!dependencies) return null;

  const handleRefresh = async () => {
    setLoading(true);
    await dependencies.checkAll(true);
    await dependencies.checkUpdates();
    setLoading(false);
  };

  const handleInstall = async (name: string) => {
    setActioning(name);
    setTakeoverConfirm(null);
    try {
      await dependencies.installDep(name);
    } catch (e) {
      console.error("Failed to install dependency:", e);
    } finally {
      setActioning(null);
    }
  };

  const handleStopManaging = async (name: string) => {
    setActioning(name);
    try {
      await dependencies.uninstallManaged(name);
    } catch (e) {
      console.error("Failed to stop managing dependency:", e);
    } finally {
      setActioning(null);
    }
  };

  const platform: "macos" | "windows" | "linux" = (() => {
    const p = navigator.platform.toLowerCase();
    if (p.includes("mac")) return "macos";
    if (p.includes("win")) return "windows";
    return "linux";
  })();

  const handleCopyUpgrade = async (name: string, cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedCmd(name);
      setTimeout(() => setCopiedCmd((c) => (c === name ? null : c)), 2000);
    } catch (e) {
      console.error("Failed to copy:", e);
    }
  };

  return (
    <div className="settings-group">
      <h4 className="settings-group-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        Dependencies
        <button
          className="ds-btn ds-btn--ghost ds-btn--sm"
          onClick={handleRefresh}
          disabled={loading}
          style={{ marginLeft: "auto" }}
        >
          {loading ? "Checking..." : "Refresh"}
        </button>
      </h4>
      <div className="settings-card">
        {dependencies.deps.length === 0 && (
          <div className="settings-row">
            <span className="settings-label" style={{ color: "var(--text-tertiary)" }}>Loading...</span>
          </div>
        )}
        {dependencies.deps.map((dep) => {
          const allConsumers = [...dep.internalConsumers, ...dep.pluginConsumers];
          const update = dependencies.updates.find((u) => u.name === dep.name);
          const outdated = update?.outdated ?? false;
          const progress = dependencies.installing[dep.name];
          const busy = actioning === dep.name || !!progress;
          const installed = dep.status === "installed";

          return (
            <div className="settings-row" key={dep.name} style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="settings-label" style={{ fontWeight: 600 }}>{dep.name}</span>
                {installed ? (
                  <span style={{ fontSize: "var(--fs-xs)", color: "var(--success)", fontWeight: 500 }}>
                    Installed{dep.version ? ` (${dep.version})` : ""}
                  </span>
                ) : (
                  <span style={{ fontSize: "var(--fs-xs)", color: "var(--warning)", fontWeight: 500 }}>
                    Not Installed
                  </span>
                )}
                {installed && dep.origin && (
                  <span style={{ fontSize: "var(--fs-2xs)", color: "var(--text-tertiary)", border: "1px solid var(--border)", borderRadius: "var(--ds-radius)", padding: "1px 6px" }}>
                    {dep.origin === "managed" ? "managed by Viboplr" : "system"}
                  </span>
                )}
                {/* Install / Update / manage actions live on the right. */}
                <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
                  {busy && progress && (
                    <span style={{ fontSize: "var(--fs-2xs)", color: "var(--text-tertiary)" }}>
                      {progress.total ? `${Math.round((progress.downloaded / progress.total) * 100)}%` : "…"}
                    </span>
                  )}
                  {!installed && dep.managedAvailable && (
                    <button className="ds-btn ds-btn--primary ds-btn--sm" onClick={() => handleInstall(dep.name)} disabled={busy}>
                      {busy ? "Installing..." : "Install"}
                    </button>
                  )}
                  {installed && outdated && dep.origin === "managed" && (
                    <button className="ds-btn ds-btn--primary ds-btn--sm" onClick={() => handleInstall(dep.name)} disabled={busy}>
                      {busy ? "Updating..." : "Update"}
                    </button>
                  )}
                  {installed && outdated && dep.origin === "system" && (
                    <button
                      className="ds-btn ds-btn--secondary ds-btn--sm"
                      onClick={() => handleCopyUpgrade(dep.name, dep.install[platform])}
                      title={dep.install[platform]}
                    >
                      {copiedCmd === dep.name ? "Copied" : "Copy upgrade command"}
                    </button>
                  )}
                  {installed && dep.origin === "system" && dep.managedAvailable && (
                    <button
                      className="ds-btn ds-btn--ghost ds-btn--sm"
                      onClick={() => setTakeoverConfirm(takeoverConfirm === dep.name ? null : dep.name)}
                      disabled={busy}
                    >
                      Let Viboplr manage
                    </button>
                  )}
                  {installed && dep.origin === "managed" && (
                    <button
                      className="ds-btn ds-btn--ghost ds-btn--sm"
                      onClick={() => handleStopManaging(dep.name)}
                      disabled={busy}
                      title="Remove Viboplr's copy and fall back to a system install"
                    >
                      {busy ? "Working..." : "Stop managing"}
                    </button>
                  )}
                </span>
              </div>
              {installed && outdated && update?.latest && (
                <span style={{ fontSize: "var(--fs-xs)", color: "var(--warning)" }}>
                  Update available: {update.installed ?? dep.version} → {update.latest}
                  {dep.origin === "system" ? " (installed outside Viboplr — update via your package manager)" : ""}
                </span>
              )}
              {takeoverConfirm === dep.name && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 10px", background: "var(--bg-tertiary)", borderRadius: "var(--ds-radius)" }}>
                  <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-secondary)" }}>
                    Viboplr will download and keep its own copy of {dep.name} up to date automatically. Your existing system copy is left in place but no longer used — you can remove it later via your package manager.
                  </span>
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button className="ds-btn ds-btn--ghost ds-btn--sm" onClick={() => setTakeoverConfirm(null)} disabled={busy}>Cancel</button>
                    <button className="ds-btn ds-btn--primary ds-btn--sm" onClick={() => handleInstall(dep.name)} disabled={busy}>
                      {busy ? "Installing..." : "Let Viboplr manage"}
                    </button>
                  </div>
                </div>
              )}
              <span className="settings-description">{dep.description}</span>
              {allConsumers.length > 0 && (
                <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-tertiary)", display: "flex", flexDirection: "column", gap: 2 }}>
                  {allConsumers.map((c) => (
                    <span key={c.name}>
                      {c.name} {c.required ? "(required)" : "(optional)"} — {c.reason}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-label">Keep dependencies up to date automatically</span>
            <span className="settings-description">
              Silently update Viboplr-managed binaries (e.g. yt-dlp) when a newer release is available. Binaries installed via a package manager are never touched.
            </span>
          </div>
          <ToggleSwitch checked={autoUpdateManagedDeps} onChange={onAutoUpdateManagedDepsChange} />
        </div>
      </div>
    </div>
  );
}

interface SettingsPanelProps {
  onSeedDatabase: () => void;
  onClearDatabase: () => void;
  clearing: boolean;
  onClearImageFailures: () => void;
  crossfadeSecs: number;
  onCrossfadeChange: (secs: number) => void;
  /** Whether this build carries the native mpv engine (full build). */
  mpvCapable: boolean;
  playbackEngine: "browser" | "native";
  onPlaybackEngineChange: (engine: "browser" | "native") => void;
  audioExclusive: boolean;
  onAudioExclusiveChange: (enabled: boolean) => void;
  rgMode: "off" | "track" | "album";
  onRgModeChange: (mode: "off" | "track" | "album") => void;
  rgPreampDb: number;
  onRgPreampDbChange: (db: number) => void;
  rgPreventClip: boolean;
  onRgPreventClipChange: (enabled: boolean) => void;
  trackVideoHistory: boolean;
  onTrackVideoHistoryChange: (enabled: boolean) => void;
  minimizeToMiniPlayer: boolean;
  onMinimizeToMiniPlayerChange: (enabled: boolean) => void;
  reduceMotion: boolean;
  onReduceMotionChange: (enabled: boolean) => void;
  uiZoom: number;
  onUiZoomChange: (factor: number) => void;
  miniZoom: number;
  onMiniZoomChange: (factor: number) => void;
  appVersion: string;
  updateState: UpdateState;
  onCheckForUpdates: () => void;
  onInstallUpdate: () => void;
  onRunSetupWizard?: () => void;
  backendTimings: TimingEntry[];
  frontendTimings: TimingEntry[];
  onFetchBackendTimings: () => void;
  // Plugins (for provider priority section)
  pluginStates?: PluginState[];
  // Logging
  loggingEnabled: boolean;
  onLoggingEnabledChange: (enabled: boolean) => void;
  debugLogging: boolean;
  onDebugLoggingChange: (enabled: boolean) => void;
  debugMode: boolean;
  onDebugModeChange: (enabled: boolean) => void;
  devPluginPath: string | null;
  onDevPluginPathChange: (path: string | null) => void;
  onReloadPlugins: () => void;
  // Stream resolver ordering
  onStreamResolverOrderChanged?: () => void;
  dependencies?: {
    deps: Array<{
      name: string;
      description: string;
      status: "installed" | "notFound" | "error";
      version?: string;
      origin?: "managed" | "system";
      internalConsumers: Array<{ name: string; reason: string; required: boolean }>;
      pluginConsumers: Array<{ name: string; reason: string; required: boolean }>;
      install: { macos: string; windows: string; linux: string; url: string };
      managedAvailable: boolean;
      latestVersion?: string;
    }>;
    updates: Array<{
      name: string;
      installed?: string;
      latest?: string;
      outdated: boolean;
      origin?: "managed" | "system";
    }>;
    installing: Record<string, { downloaded: number; total: number | null }>;
    checkAll: (forceRefresh?: boolean) => Promise<unknown>;
    checkUpdates: () => Promise<unknown>;
    installDep: (name: string) => Promise<string | null>;
    uninstallManaged: (name: string) => Promise<void>;
  };
  autoUpdateManagedDeps: boolean;
  onAutoUpdateManagedDepsChange: (enabled: boolean) => void;
}

type SettingsTab = "general" | "providers" | "debug";

export function SettingsPanel({
  onSeedDatabase, onClearDatabase, clearing,
  onClearImageFailures,
  crossfadeSecs,
  onCrossfadeChange,
  mpvCapable,
  playbackEngine,
  onPlaybackEngineChange,
  audioExclusive,
  onAudioExclusiveChange,
  rgMode,
  onRgModeChange,
  rgPreampDb,
  onRgPreampDbChange,
  rgPreventClip,
  onRgPreventClipChange,
  trackVideoHistory,
  onTrackVideoHistoryChange,
  minimizeToMiniPlayer,
  onMinimizeToMiniPlayerChange,
  reduceMotion,
  onReduceMotionChange,
  uiZoom,
  onUiZoomChange,
  miniZoom,
  onMiniZoomChange,
  appVersion,
  updateState,
  onCheckForUpdates,
  onInstallUpdate,
  onRunSetupWizard,
  backendTimings,
  frontendTimings,
  onFetchBackendTimings,
  pluginStates,
  loggingEnabled,
  onLoggingEnabledChange,
  debugLogging,
  onDebugLoggingChange,
  debugMode,
  onDebugModeChange,
  devPluginPath,
  onDevPluginPathChange,
  onReloadPlugins,
  onStreamResolverOrderChanged,
  dependencies,
  autoUpdateManagedDeps,
  onAutoUpdateManagedDepsChange,
}: SettingsPanelProps) {
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");

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

  const navItems: { key: SettingsTab; label: string; icon: ReactNode }[] = [
    { key: "general", label: "General", icon: navIcons.general },
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
                  <div className="settings-group-title">ViboPLR</div>
                  <div className="settings-card">
                    <div className="settings-about-content">
                    <div className="settings-about-logo" style={{ cursor: "pointer" }} onClick={() => openUrl(LINKS.homepage).catch(console.error)}>
                      <svg width="32" height="32" viewBox="0 0 512 512" fill="none">
                        <defs><linearGradient id="aboutVGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#FF6B6B"/><stop offset="100%" stopColor="#E91E8A"/></linearGradient></defs>
                        <path d="M120,110 L256,400 L392,110" fill="none" stroke="url(#aboutVGrad)" strokeWidth="56" strokeLinecap="round" strokeLinejoin="round"/>
                        <circle cx="256" cy="400" r="16" fill="url(#aboutVGrad)" opacity="0.6"/>
                      </svg>
                    </div>
                    <div className="settings-about-info">
                      <span className="settings-about-name">Viboplr</span>
                      <span className="settings-about-version">v{appVersion} &middot; <a href="#" className="settings-about-link" onClick={(e) => { e.preventDefault(); openUrl(LINKS.homepage).catch(console.error); }}>viboplr.com</a></span>
                    </div>
                    <div className="settings-about-actions">
                      {updateState.available && !updateState.downloading && (
                        <button className="ds-btn ds-btn--primary ds-btn--sm" onClick={onInstallUpdate}>
                          Update to v{updateState.available.version}
                        </button>
                      )}
                      {updateState.downloading && (
                        <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-secondary)" }}>Downloading...</span>
                      )}
                      {!updateState.available && !updateState.downloading && (
                        <>
                          {updateState.upToDate && (
                            <span className="update-up-to-date">Up to date</span>
                          )}
                          {!updateState.upToDate && (
                            <button
                              className="ds-btn ds-btn--secondary ds-btn--sm"
                              onClick={onCheckForUpdates}
                              disabled={updateState.checking}
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                              {updateState.checking ? "Checking..." : "Check for Updates"}
                            </button>
                          )}
                        </>
                      )}
                      <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={() => openUrl(LINKS.supportPage).catch(console.error)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                        Support
                      </button>
                      {onRunSetupWizard && (
                        <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={onRunSetupWizard}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>
                          Setup Wizard
                        </button>
                      )}
                    </div>
                  </div>
                  </div>
                </div>

                <div className="settings-group">
                  <div className="settings-group-title">Playback</div>
                  <div className="settings-card">
                    {mpvCapable && (
                      <div className="settings-row">
                        <div className="settings-row-info">
                          <span className="settings-label">Playback engine</span>
                          <span className="settings-description">mpv plays every format natively with sample-accurate gapless; on macOS it also renders video (beta). Switching stops playback.</span>
                        </div>
                        <select
                          className="ds-select"
                          value={playbackEngine}
                          onChange={e => onPlaybackEngineChange(e.target.value as "browser" | "native")}
                        >
                          <option value="browser">Browser</option>
                          <option value="native">mpv (beta)</option>
                        </select>
                      </div>
                    )}
                    {mpvCapable && playbackEngine === "native" && (
                      <div className="settings-row">
                        <div className="settings-row-info">
                          <span className="settings-label">Exclusive audio access</span>
                          <span className="settings-description">Opens the output device exclusively (bit-perfect: also disable EQ and ReplayGain and keep volume at 100%). Disables crossfade; applies from the next track. Other apps can't play audio while active.</span>
                        </div>
                        <div
                          className={`ds-toggle ${audioExclusive ? "on" : ""}`}
                          onClick={() => onAudioExclusiveChange(!audioExclusive)}
                          role="switch"
                          aria-checked={audioExclusive}
                        >
                          <div className="ds-toggle-thumb" />
                        </div>
                      </div>
                    )}
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
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">ReplayGain</span>
                        <span className="settings-description">Normalize loudness across tracks using embedded ReplayGain tags</span>
                      </div>
                      <select
                        className="ds-select"
                        value={rgMode}
                        onChange={e => onRgModeChange(e.target.value as "off" | "track" | "album")}
                      >
                        <option value="off">Off</option>
                        <option value="track">Track</option>
                        <option value="album">Album</option>
                      </select>
                    </div>
                    {rgMode !== "off" && (
                      <>
                        <div className="settings-row">
                          <div className="settings-row-info">
                            <span className="settings-label">Pre-amp</span>
                            <span className="settings-description">Extra gain applied on top of ReplayGain</span>
                          </div>
                          <div className="settings-row-control settings-row-slider">
                            <input
                              type="range"
                              min={-15}
                              max={15}
                              step={0.5}
                              value={rgPreampDb}
                              onChange={e => onRgPreampDbChange(parseFloat(e.target.value))}
                              className="settings-slider"
                            />
                            <span className="settings-value">{rgPreampDb > 0 ? "+" : ""}{rgPreampDb.toFixed(1)} dB</span>
                          </div>
                        </div>
                        <div className="settings-row">
                          <div className="settings-row-info">
                            <span className="settings-label">Prevent clipping</span>
                            <span className="settings-description">Cap the gain using the track's peak so loud masters never clip</span>
                          </div>
                          <ToggleSwitch checked={rgPreventClip} onChange={onRgPreventClipChange} />
                        </div>
                      </>
                    )}
                  </div>
                </div>

                <div className="settings-group">
                  <div className="settings-group-title">Window</div>
                  <div className="settings-card">
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Interface size</span>
                        <span className="settings-description">Scale the whole interface — text, spacing, and artwork. Also adjustable with {MOD_KEY_LABEL} + and {MOD_KEY_LABEL} −.</span>
                      </div>
                      <select
                        className="ds-select"
                        value={uiZoom}
                        onChange={e => onUiZoomChange(parseFloat(e.target.value))}
                      >
                        {ZOOM_PRESET_OPTIONS.map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Mini player size</span>
                        <span className="settings-description">Scale the mini player independently of the main window</span>
                      </div>
                      <select
                        className="ds-select"
                        value={miniZoom}
                        onChange={e => onMiniZoomChange(parseFloat(e.target.value))}
                      >
                        {ZOOM_PRESET_OPTIONS.map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Minimize to mini player</span>
                        <span className="settings-description">Switch to mini player when minimizing the window</span>
                      </div>
                      <ToggleSwitch checked={minimizeToMiniPlayer} onChange={onMinimizeToMiniPlayerChange} />
                    </div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Reduce motion</span>
                        <span className="settings-description">Minimise animations across the app — disables the mini-player text scroll, list reordering, and transitions. Also honoured automatically when your OS "reduce motion" setting is on.</span>
                      </div>
                      <ToggleSwitch checked={reduceMotion} onChange={onReduceMotionChange} />
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

                <DependenciesSection
                  dependencies={dependencies}
                  autoUpdateManagedDeps={autoUpdateManagedDeps}
                  onAutoUpdateManagedDepsChange={onAutoUpdateManagedDepsChange}
                />

              </>
            )}

            {settingsTab === "providers" && (
                <ProviderPrioritySection pluginStates={pluginStates} onStreamResolverOrderChanged={onStreamResolverOrderChanged} />
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
                      <span className="settings-label">Debug logging</span>
                      <span className="settings-description">Also log frontend activity (playback, downloads, plugins, etc.) to the log file</span>
                    </div>
                    <ToggleSwitch checked={debugLogging} onChange={onDebugLoggingChange} />
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
                <div className="settings-group-title" style={{ marginTop: 20 }}>Mode</div>
                <div className="settings-card">
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <span className="settings-label">Debug mode</span>
                      <span className="settings-description">Show extra diagnostic information in tooltips and UI elements</span>
                    </div>
                    <ToggleSwitch checked={debugMode} onChange={onDebugModeChange} />
                  </div>
                </div>
                {debugMode && (
                  <>
                    <div className="settings-group-title" style={{ marginTop: 20 }}>Developer</div>
                    <div className="settings-card">
                      <div className="settings-row">
                        <div className="settings-row-info">
                          <span className="settings-label">Dev plugin folder</span>
                          <span className="settings-description">
                            Loads a plugin from this folder (overrides installed copies). After editing its files, click Reload to pick up the changes. Debug mode only.
                          </span>
                          <span className="settings-description" style={{ fontFamily: "monospace", wordBreak: "break-all" }}>
                            {devPluginPath || "none"}
                          </span>
                        </div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <button
                            className="ds-btn ds-btn--secondary"
                            disabled={!devPluginPath}
                            onClick={() => onReloadPlugins()}
                          >
                            Reload
                          </button>
                          <button
                            className="ds-btn ds-btn--secondary"
                            onClick={async () => {
                              try {
                                const picked = await open({ directory: true, multiple: false });
                                if (typeof picked === "string") onDevPluginPathChange(picked);
                              } catch (e) {
                                console.error("Failed to pick dev plugin folder:", e);
                              }
                            }}
                          >
                            Choose…
                          </button>
                          <button
                            className="ds-btn ds-btn--secondary"
                            disabled={!devPluginPath}
                            onClick={() => onDevPluginPathChange(null)}
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                    </div>
                  </>
                )}
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
