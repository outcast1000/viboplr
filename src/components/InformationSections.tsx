import { renderers } from "./renderers";
import type { InfoEntity, InfoPlacement } from "../types/informationTypes";
import { getInfoPlacement } from "../types/informationTypes";
import { useInformationTypes } from "../hooks/useInformationTypes";
import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./InformationSections.css";

interface InformationSectionsProps {
  entity: InfoEntity | null;
  exclude?: string[];
  placement?: InfoPlacement;
  invokeInfoFetch: (
    pluginId: string,
    infoTypeId: string,
    entity: InfoEntity,
  ) => Promise<import("../types/informationTypes").InfoFetchResult>;
  onEntityClick?: (kind: string, id?: number, name?: string) => void;
  onAction?: (actionId: string, payload?: unknown) => void;
  resolveEntity?: (kind: string, name: string) => { id?: number; imageSrc?: string } | undefined;
}

export function InformationSections({
  entity,
  exclude,
  placement,
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

  if (!filtered.length) return null;

  const toggleCollapse = (typeId: string) => {
    setCollapsed((prev) => ({ ...prev, [typeId]: !prev[typeId] }));
  };

  const useTabMode = placement === "right" && filtered.length > 1;

  if (useTabMode) {
    const resolvedTab = (activeTab && filtered.some(s => s.typeId === activeTab))
      ? activeTab
      : filtered[0].typeId;
    const activeSection = filtered.find(s => s.typeId === resolvedTab)!;
    const Renderer = renderers[activeSection.displayKind];
    const meta = activeSection.state.kind === "loaded" && activeSection.state.data
      ? (activeSection.state.data as Record<string, unknown>)?._meta as { url?: string; providerName?: string } | undefined
      : undefined;

    return (
      <div className={`information-sections information-sections--${placement}`}>
        <div className="info-sections-tabs">
          {filtered.map(section => (
            <div
              key={section.typeId}
              className={`info-sections-tab${section.typeId === resolvedTab ? " active" : ""}`}
              onClick={() => setActiveTab(section.typeId)}
            >
              {section.name}
            </div>
          ))}
          {meta?.url && meta?.providerName && (
            <a className="info-section-view-on" href="#" onClick={(e) => { e.preventDefault(); openUrl(meta.url!); }}>
              View on {meta.providerName}
            </a>
          )}
        </div>
        <div className="info-section-content">
          {activeSection.state.kind === "loading" ? (
            <div className="info-section-skeleton" />
          ) : activeSection.state.kind === "loaded" && activeSection.state.data && Renderer ? (
            <Renderer data={activeSection.state.data} onEntityClick={onEntityClick} onAction={onAction} resolveEntity={resolveEntity} />
          ) : null}
        </div>
      </div>
    );
  }

  // Stacked/collapsible rendering (existing behavior)
  return (
    <div className={`information-sections${placement ? ` information-sections--${placement}` : ""}`}>
      {filtered.map((section) => {
        const Renderer = renderers[section.displayKind];
        if (!Renderer) return null;
        const isCollapsed = collapsed[section.typeId] === true;
        const meta = section.state.kind === "loaded" && section.state.data
          ? (section.state.data as Record<string, unknown>)?._meta as { url?: string; providerName?: string } | undefined
          : undefined;

        return (
          <div key={section.typeId} className="info-section">
            <div className="section-title section-header" onClick={() => toggleCollapse(section.typeId)}>
              <svg className={`section-chevron${isCollapsed ? " collapsed" : ""}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              {section.name}
              {meta?.url && meta?.providerName && (
                <a className="info-section-view-on" href="#" onClick={(e) => { e.preventDefault(); e.stopPropagation(); openUrl(meta.url!); }}>
                  View on {meta.providerName}
                </a>
              )}
            </div>
            {!isCollapsed && (
              <div className="info-section-content">
                {section.state.kind === "loading" ? (
                  <div className="info-section-skeleton" />
                ) : section.state.kind === "loaded" && section.state.data ? (
                  <Renderer data={section.state.data} onEntityClick={onEntityClick} onAction={onAction} resolveEntity={resolveEntity} />
                ) : null}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
