import { renderers } from "./renderers";
import type { InfoEntity } from "../types/informationTypes";
import { useInformationTypes } from "../hooks/useInformationTypes";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { buildEntityKey } from "../types/informationTypes";
import "./InformationSections.css";

export interface CustomTab {
  id: string;
  name: string;
  content: ReactNode;
}

interface InformationSectionsProps {
  entity: InfoEntity | null;
  exclude?: string[];
  customTabs?: CustomTab[];
  positionSecs?: number;
  invokeInfoFetch: (
    pluginId: string,
    infoTypeId: string,
    entity: InfoEntity,
    onFetchUrl?: (url: string) => void,
  ) => Promise<import("../types/informationTypes").InfoFetchResult>;
  pluginNames?: Map<string, string>;
  /** Preferred tab order — tab IDs listed here appear first in this order, rest follow */
  tabOrder?: string[];
  /** Called when user reorders tabs via drag-and-drop; receives the full ordered list of tab IDs */
  onTabOrderChange?: (order: string[]) => void;
  onEntityClick?: (kind: string, id?: number, name?: string) => void;
  onAction?: (actionId: string, payload?: unknown) => void;
  resolveEntity?: (kind: string, name: string) => { id?: number; imageSrc?: string } | undefined;
  /** Called when title_line sections have loaded data (typeId → parsed data) */
  onTitleData?: (typeId: string, data: unknown) => void;
  onTrackContextMenu?: (e: React.MouseEvent, trackInfo: { trackId?: number; title: string; artistName: string | null }) => void;
  onEntityContextMenu?: (e: React.MouseEvent, info: { kind: "track" | "artist" | "album"; id?: number; name: string; artistName?: string | null }) => void;
}

type TabEntry =
  | { kind: "plugin"; typeId: string; name: string; description?: string; section: import("../types/informationTypes").InfoSection }
  | { kind: "custom"; id: string; name: string; description?: string; content: ReactNode };

export function InformationSections({
  entity,
  exclude,
  customTabs,
  positionSecs,
  invokeInfoFetch,
  pluginNames,
  tabOrder,
  onTabOrderChange,
  onEntityClick,
  onAction,
  resolveEntity,
  onTitleData,
  onTrackContextMenu,
  onEntityContextMenu,
}: InformationSectionsProps) {
  const { sections, refresh, reloadCache } = useInformationTypes({ entity, exclude, invokeInfoFetch, pluginNames });
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  // Tab drag-and-drop state
  const [draggedTab, setDraggedTab] = useState<string | null>(null);
  const [dragOverTab, setDragOverTab] = useState<string | null>(null);
  const draggedTabRef = useRef<string | null>(null);
  const dragOverTabRef = useRef<string | null>(null);
  const didDragTabRef = useRef(false);
  const tabGhostRef = useRef<HTMLDivElement | null>(null);

  // Reset to first tab when entity changes
  const entityKey = entity ? buildEntityKey(entity) : null;
  useEffect(() => { setActiveTab(null); }, [entityKey]);

  // Notify parent about title_line data (filtered from tabs but still fetched)
  useEffect(() => {
    if (!onTitleData) return;
    for (const s of sections) {
      if (s.displayKind === "title_line" && s.state.kind === "loaded" && s.state.data) {
        onTitleData(s.typeId, s.state.data);
      }
    }
  }, [sections, onTitleData]);

  const handleAction = useCallback(async (actionId: string, payload?: unknown) => {
    if (actionId === "save-lyrics" && entity) {
      const p = payload as { text: string; kind: string } | undefined;
      if (!p) return;
      const entityKey = buildEntityKey(entity);
      const cached = await invoke<[number, string, string, string, number][]>(
        "info_get_values_for_entity",
        { entityKey },
      );
      const lyricsEntry = cached.find(([, typeId]) => typeId === "lyrics");
      if (lyricsEntry) {
        await invoke("info_upsert_value", {
          informationTypeId: lyricsEntry[0],
          entityKey,
          value: JSON.stringify({ text: p.text, kind: p.kind }),
          status: "ok",
        });
        // Reload from cache (does NOT delete+refetch like refresh does)
        reloadCache();
      }
      return;
    }
    if (actionId === "play-track") {
      const p = payload as { id: number } | undefined;
      if (p?.id) {
        const track = await invoke<{ id: number; path: string; title: string; artist_name?: string; album_title?: string; duration_secs?: number } | null>("get_track_by_id", { trackId: p.id });
        if (track && onAction) onAction("play-track", track);
      }
      return;
    }
    if (actionId === "play-or-youtube") {
      const p = payload as { name: string; artist?: string } | undefined;
      if (p) {
        try {
          const results = await invoke<Array<{ id: number; title: string; artist_name?: string }>>(
            "get_tracks", { opts: { query: p.name, limit: 10 } }
          );
          const match = results.find(t =>
            t.title.toLowerCase() === p.name.toLowerCase() &&
            (!p.artist || (t.artist_name ?? "").toLowerCase() === p.artist.toLowerCase())
          );
          if (match) {
            const track = await invoke<{ id: number; path: string; title: string; artist_name?: string; album_title?: string; duration_secs?: number } | null>("get_track_by_id", { trackId: match.id });
            if (track && onAction) { onAction("play-track", track); return; }
          }
        } catch { /* fall through to youtube */ }
        try {
          const result = await invoke<{ url: string; video_title: string | null }>(
            "search_youtube", { title: p.name, artistName: p.artist ?? null }
          );
          openUrl(result.url);
        } catch {
          const q = encodeURIComponent(`${p.name} ${p.artist ?? ""}`);
          openUrl(`https://www.youtube.com/results?search_query=${q}`);
        }
      }
      return;
    }
    if (actionId === "youtube-search") {
      const p = payload as { name: string; artist?: string } | undefined;
      if (p) {
        try {
          const result = await invoke<{ url: string; video_title: string | null }>(
            "search_youtube", { title: p.name, artistName: p.artist ?? null }
          );
          openUrl(result.url);
        } catch {
          const q = encodeURIComponent(`${p.name} ${p.artist ?? ""}`);
          openUrl(`https://www.youtube.com/results?search_query=${q}`);
        }
      }
      return;
    }
    if (onAction) onAction(actionId, payload);
  }, [entity, onAction, reloadCache]);

  function handleTabMouseDown(e: React.MouseEvent, tabId: string) {
    if (e.button !== 0 || !onTabOrderChange) return;
    draggedTabRef.current = tabId;
    dragOverTabRef.current = null;
    didDragTabRef.current = false;
    const startX = e.clientX;
    const startY = e.clientY;

    function findTabId(el: Element | null): string | null {
      while (el) {
        const id = el.getAttribute("data-tab-id");
        if (id) return id;
        el = el.parentElement;
      }
      return null;
    }

    function showGhost(x: number, y: number) {
      if (!tabGhostRef.current) {
        const ghost = document.createElement("div");
        ghost.className = "info-tab-drag-ghost";
        const entry = tabs.find(t => getTabId(t) === tabId);
        ghost.textContent = entry?.name ?? tabId;
        document.body.appendChild(ghost);
        tabGhostRef.current = ghost;
      }
      tabGhostRef.current.style.left = `${x + 12}px`;
      tabGhostRef.current.style.top = `${y - 10}px`;
    }

    function removeGhost() {
      if (tabGhostRef.current) { tabGhostRef.current.remove(); tabGhostRef.current = null; }
    }

    function onMouseMove(ev: MouseEvent) {
      if (!draggedTabRef.current) return;
      if (!didDragTabRef.current) {
        if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 5) return;
        didDragTabRef.current = true;
        setDraggedTab(draggedTabRef.current);
      }
      showGhost(ev.clientX, ev.clientY);
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const overId = target ? findTabId(target) : null;
      if (overId && overId !== draggedTabRef.current) {
        dragOverTabRef.current = overId;
        setDragOverTab(overId);
      } else {
        dragOverTabRef.current = null;
        setDragOverTab(null);
      }
    }

    function onMouseUp() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      removeGhost();
      const from = draggedTabRef.current;
      const to = dragOverTabRef.current;
      if (didDragTabRef.current && from && to && from !== to) {
        // Compute new order from the current visible (non-empty-sorted) tab list
        const ids = tabs.map(t => getTabId(t));
        const fromIdx = ids.indexOf(from);
        const toIdx = ids.indexOf(to);
        if (fromIdx !== -1 && toIdx !== -1) {
          ids.splice(fromIdx, 1);
          ids.splice(toIdx, 0, from);
          onTabOrderChange!(ids);
        }
      }
      draggedTabRef.current = null;
      dragOverTabRef.current = null;
      setDraggedTab(null);
      setDragOverTab(null);
      setTimeout(() => { didDragTabRef.current = false; }, 0);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  const filtered = sections.filter(s => s.displayKind !== "title_line");

  // Build unified tab list: custom tabs first, then plugin sections
  const tabs: TabEntry[] = [
    ...(customTabs ?? []).map(ct => ({ kind: "custom" as const, id: ct.id, name: ct.name, content: ct.content })),
    ...filtered.map(s => ({ kind: "plugin" as const, typeId: s.typeId, name: s.name, description: s.description, section: s })),
  ];

  const getTabId = (t: TabEntry) => t.kind === "custom" ? t.id : t.typeId;

  // Apply preferred tab ordering if specified, then sort empty tabs last
  {
    const isEmpty = (t: TabEntry) => {
      if (t.kind === "custom") return 0;
      return t.section.state.kind === "empty" ? 1 : 0;
    };
    tabs.sort((a, b) => {
      // Primary: tabs with data before empty tabs
      const emptyDiff = isEmpty(a) - isEmpty(b);
      if (emptyDiff !== 0) return emptyDiff;
      // Secondary: preferred tab order
      if (tabOrder && tabOrder.length > 0) {
        const aId = getTabId(a);
        const bId = getTabId(b);
        const aIdx = tabOrder.indexOf(aId);
        const bIdx = tabOrder.indexOf(bId);
        if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
        if (aIdx >= 0) return -1;
        if (bIdx >= 0) return 1;
      }
      return 0;
    });
  }

  if (!tabs.length) return null;

  const resolvedTab = (activeTab && tabs.some(t => getTabId(t) === activeTab))
    ? activeTab
    : getTabId(tabs[0]);
  const activeEntry = tabs.find(t => getTabId(t) === resolvedTab)!;

  // Extract meta for provider attribution (plugin sections only)
  let meta: { url?: string; providerName?: string; homepageUrl?: string } | undefined;
  if (activeEntry.kind === "plugin") {
    const s = activeEntry.section;
    meta = s.state.kind === "loaded" && s.state.data
      ? (s.state.data as Record<string, unknown>)?._meta as { url?: string; providerName?: string; homepageUrl?: string } | undefined
      : undefined;
  }

  return (
    <div className="information-sections">
      <div className="info-sections-tabs">
        <svg
          className={`section-chevron info-sections-collapse${collapsed ? " collapsed" : ""}`}
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          onClick={() => setCollapsed(c => !c)}
        >
          <polyline points="6 9 12 15 18 9"/>
        </svg>
        {tabs.map(tab => {
          const tabId = getTabId(tab);
          const tabState = tab.kind === "plugin" ? tab.section.state.kind : null;
          return (
            <div
              key={tabId}
              data-tab-id={tabId}
              className={`info-sections-tab${tabId === resolvedTab ? " active" : ""}${tabState === "empty" ? " empty" : ""}${tabState === "loading" ? " loading" : ""}${tabState === "loaded" ? " has-data" : ""}${draggedTab === tabId ? " dragging" : ""}${dragOverTab === tabId ? " drag-over" : ""}`}
              onClick={() => { if (!didDragTabRef.current) { setActiveTab(tabId); setCollapsed(false); } }}
              onMouseDown={(e) => handleTabMouseDown(e, tabId)}
              {...(tab.description ? { "data-tooltip": tab.description } : {})}
            >
              {tab.name}
              {tabState === "loading" && <span className="info-tab-dot loading" />}
              {tabState === "loaded" && <span className="info-tab-dot loaded" />}
            </div>
          );
        })}
        {!collapsed && activeEntry.kind === "plugin" && (
          <svg
            className="info-sections-refresh"
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            onClick={() => refresh(activeEntry.typeId)}
          >
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        )}
      </div>
      {!collapsed && (
        <div className="info-section-content">
          {activeEntry.kind === "custom" ? (
            activeEntry.content
          ) : (() => {
            const s = activeEntry.section;
            const Renderer = renderers[s.displayKind];
            return s.state.kind === "loading" ? (
              <div className="info-section-loading">
                <div className="info-section-skeleton" />
                {s.state.progress && s.state.progress.length > 0 && (
                  <div className="info-section-progress">
                    {s.state.progress.map((p, i) => (
                      <div key={i} className={`info-progress-entry${p.status === "ok" ? " ok" : p.status === "not_found" || p.status === "error" ? " fail" : ""}`}>
                        <span className="info-progress-provider">{p.provider}</span>
                        {p.url && <span className="info-progress-url">{p.url}</span>}
                        {p.status === "fetching" && <span className="info-progress-status">...</span>}
                        {p.status === "ok" && <span className="info-progress-status">found</span>}
                        {p.status === "not_found" && <span className="info-progress-status">not found</span>}
                        {p.status === "error" && <span className="info-progress-status">error</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : s.state.kind === "loaded" && s.state.data && Renderer ? (
              <Renderer data={s.state.data} onEntityClick={onEntityClick} onAction={handleAction} resolveEntity={resolveEntity} context={positionSecs != null ? { positionSecs } : undefined} onTrackContextMenu={onTrackContextMenu} onEntityContextMenu={onEntityContextMenu} />
            ) : s.state.kind === "empty" ? (
              <div className="info-section-empty">No data available</div>
            ) : null;
          })()}
          {meta?.providerName && (meta?.url ? (
            <a className="info-section-view-on" href="#" onClick={(e) => { e.preventDefault(); openUrl(meta.url!); }}>
              View on {meta.providerName}
            </a>
          ) : (
            <span className="info-section-view-on">
              Source: {meta.homepageUrl ? (
                <a href="#" onClick={(e) => { e.preventDefault(); openUrl(meta!.homepageUrl!); }}>{meta.providerName}</a>
              ) : meta.providerName}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
