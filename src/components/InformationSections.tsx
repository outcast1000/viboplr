import { renderers } from "./renderers";
import type { InfoEntity, InfoPlacement } from "../types/informationTypes";
import { getInfoPlacement } from "../types/informationTypes";
import { useInformationTypes } from "../hooks/useInformationTypes";
import type { ReactNode } from "react";
import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
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
  invokeInfoFetch,
  onEntityClick,
  onAction,
  resolveEntity,
}: InformationSectionsProps) {
  const { sections } = useInformationTypes({ entity, exclude, invokeInfoFetch });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [activeTab, setActiveTab] = useState<string | null>(null);

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

  const toggleCollapse = (typeId: string) => {
    setCollapsed((prev) => ({ ...prev, [typeId]: !prev[typeId] }));
  };

  const useTabMode = tabs.length > 1;

  if (useTabMode) {
    const resolvedTab = (activeTab && tabs.some(t => getTabId(t) === activeTab))
      ? activeTab
      : getTabId(tabs[0]);
    const activeEntry = tabs.find(t => getTabId(t) === resolvedTab)!;

    // Extract meta for "View on Provider" link (plugin sections only)
    let meta: { url?: string; providerName?: string } | undefined;
    if (activeEntry.kind === "plugin") {
      const s = activeEntry.section;
      meta = s.state.kind === "loaded" && s.state.data
        ? (s.state.data as Record<string, unknown>)?._meta as { url?: string; providerName?: string } | undefined
        : undefined;
    }

    return (
      <div className={`information-sections${placement ? ` information-sections--${placement}` : ""}`}>
        <div className="info-sections-tabs">
          {tabs.map(tab => (
            <div
              key={getTabId(tab)}
              className={`info-sections-tab${getTabId(tab) === resolvedTab ? " active" : ""}`}
              onClick={() => setActiveTab(getTabId(tab))}
            >
              {tab.name}
            </div>
          ))}
        </div>
        <div className="info-section-content">
          {activeEntry.kind === "custom" ? (
            activeEntry.content
          ) : (() => {
            const s = activeEntry.section;
            const Renderer = renderers[s.displayKind];
            return s.state.kind === "loading" ? (
              <div className="info-section-skeleton" />
            ) : s.state.kind === "loaded" && s.state.data && Renderer ? (
              <Renderer data={s.state.data} onEntityClick={onEntityClick} onAction={onAction} resolveEntity={resolveEntity} />
            ) : null;
          })()}
        </div>
        {meta?.url && meta?.providerName && (
          <a className="info-section-view-on" href="#" onClick={(e) => { e.preventDefault(); openUrl(meta.url!); }}>
            View on {meta.providerName}
          </a>
        )}
      </div>
    );
  }

  // Single tab — render as plain section (no tab bar)
  const single = tabs[0];
  if (single.kind === "custom") {
    return (
      <div className={`information-sections${placement ? ` information-sections--${placement}` : ""}`}>
        <div className="info-section">
          <div className="section-title">{single.name}</div>
          <div className="info-section-content">{single.content}</div>
        </div>
      </div>
    );
  }

  // Single plugin section — collapsible
  const section = single.section;
  const Renderer = renderers[section.displayKind];
  if (!Renderer) return null;
  const isCollapsed = collapsed[section.typeId] === true;
  const singleMeta = section.state.kind === "loaded" && section.state.data
    ? (section.state.data as Record<string, unknown>)?._meta as { url?: string; providerName?: string } | undefined
    : undefined;

  return (
    <div className={`information-sections${placement ? ` information-sections--${placement}` : ""}`}>
      <div className="info-section">
        <div className="section-title section-header" onClick={() => toggleCollapse(section.typeId)}>
          <svg className={`section-chevron${isCollapsed ? " collapsed" : ""}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          {section.name}
        </div>
        {!isCollapsed && (
          <>
            <div className="info-section-content">
              {section.state.kind === "loading" ? (
                <div className="info-section-skeleton" />
              ) : section.state.kind === "loaded" && section.state.data ? (
                <Renderer data={section.state.data} onEntityClick={onEntityClick} onAction={onAction} resolveEntity={resolveEntity} />
              ) : null}
            </div>
            {singleMeta?.url && singleMeta?.providerName && (
              <a className="info-section-view-on" href="#" onClick={(e) => { e.preventDefault(); openUrl(singleMeta.url!); }}>
                View on {singleMeta.providerName}
              </a>
            )}
          </>
        )}
      </div>
    </div>
  );
}
