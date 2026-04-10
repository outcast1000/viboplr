import { renderers } from "./renderers";
import type { InfoEntity, InfoPlacement } from "../types/informationTypes";
import { getInfoPlacement } from "../types/informationTypes";
import { useInformationTypes } from "../hooks/useInformationTypes";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
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
  placement?: InfoPlacement;
  customTabs?: CustomTab[];
  positionSecs?: number;
  invokeInfoFetch: (
    pluginId: string,
    infoTypeId: string,
    entity: InfoEntity,
  ) => Promise<import("../types/informationTypes").InfoFetchResult>;
  onEntityClick?: (kind: string, id?: number, name?: string) => void;
  onAction?: (actionId: string, payload?: unknown) => void;
  resolveEntity?: (kind: string, name: string) => { id?: number; imageSrc?: string } | undefined;
}

type TabEntry =
  | { kind: "plugin"; typeId: string; name: string; section: import("../types/informationTypes").InfoSection }
  | { kind: "custom"; id: string; name: string; content: ReactNode };

export function InformationSections({
  entity,
  exclude,
  placement,
  customTabs,
  positionSecs,
  invokeInfoFetch,
  onEntityClick,
  onAction,
  resolveEntity,
}: InformationSectionsProps) {
  const { sections, refresh, reloadCache } = useInformationTypes({ entity, exclude, invokeInfoFetch });
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

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

  const filtered = placement
    ? sections.filter(s => s.displayKind !== "title_line" && getInfoPlacement(s.displayKind) === placement)
    : sections.filter(s => s.displayKind !== "title_line");

  // Build unified tab list: custom tabs first, then plugin sections
  const tabs: TabEntry[] = [
    ...(customTabs ?? []).map(ct => ({ kind: "custom" as const, id: ct.id, name: ct.name, content: ct.content })),
    ...filtered.map(s => ({ kind: "plugin" as const, typeId: s.typeId, name: s.name, section: s })),
  ];

  if (!tabs.length) return null;

  const getTabId = (t: TabEntry) => t.kind === "custom" ? t.id : t.typeId;

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
    <div className={`information-sections${placement ? ` information-sections--${placement}` : ""}`}>
      <div className="info-sections-tabs">
        <svg
          className={`section-chevron info-sections-collapse${collapsed ? " collapsed" : ""}`}
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          onClick={() => setCollapsed(c => !c)}
        >
          <polyline points="6 9 12 15 18 9"/>
        </svg>
        {tabs.map(tab => (
          <div
            key={getTabId(tab)}
            className={`info-sections-tab${getTabId(tab) === resolvedTab ? " active" : ""}${tab.kind === "plugin" && tab.section.state.kind === "empty" ? " empty" : ""}`}
            onClick={() => { setActiveTab(getTabId(tab)); setCollapsed(false); }}
          >
            {tab.name}
          </div>
        ))}
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
        <>
          <div className="info-section-content">
            {activeEntry.kind === "custom" ? (
              activeEntry.content
            ) : (() => {
              const s = activeEntry.section;
              const Renderer = renderers[s.displayKind];
              return s.state.kind === "loading" ? (
                <div className="info-section-skeleton" />
              ) : s.state.kind === "loaded" && s.state.data && Renderer ? (
                <Renderer data={s.state.data} onEntityClick={onEntityClick} onAction={handleAction} resolveEntity={resolveEntity} context={positionSecs != null ? { positionSecs } : undefined} />
              ) : s.state.kind === "empty" ? (
                <div className="info-section-empty">No data available</div>
              ) : null;
            })()}
          </div>
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
        </>
      )}
    </div>
  );
}
