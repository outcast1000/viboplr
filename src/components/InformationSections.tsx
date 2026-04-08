import { renderers } from "./renderers";
import type { InfoEntity } from "../types/informationTypes";
import { useInformationTypes } from "../hooks/useInformationTypes";
import { useState } from "react";
import "./InformationSections.css";

interface InformationSectionsProps {
  entity: InfoEntity | null;
  exclude?: string[];
  invokeInfoFetch: (
    pluginId: string,
    infoTypeId: string,
    entity: InfoEntity,
  ) => Promise<import("../types/informationTypes").InfoFetchResult>;
  onEntityClick?: (kind: string, id?: number, name?: string) => void;
  onAction?: (actionId: string, payload?: unknown) => void;
}

export function InformationSections({
  entity,
  exclude,
  invokeInfoFetch,
  onEntityClick,
  onAction,
}: InformationSectionsProps) {
  const { sections } = useInformationTypes({ entity, exclude, invokeInfoFetch });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  if (!sections.length) return null;

  const toggleCollapse = (typeId: string) => {
    setCollapsed((prev) => ({ ...prev, [typeId]: !prev[typeId] }));
  };

  return (
    <div className="information-sections">
      {sections.map((section) => {
        if (section.displayKind === "title_line") return null;
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
                <a className="info-section-view-on" href={meta.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                  View on {meta.providerName}
                </a>
              )}
            </div>
            {!isCollapsed && (
              <div className="info-section-content">
                {section.state.kind === "loading" ? (
                  <div className="info-section-skeleton" />
                ) : section.state.kind === "loaded" && section.state.data ? (
                  <Renderer data={section.state.data} onEntityClick={onEntityClick} onAction={onAction} />
                ) : null}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
