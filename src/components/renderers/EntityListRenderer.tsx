import { openUrl } from "@tauri-apps/plugin-opener";
import type { RendererProps } from "./index";
import type { EntityListData } from "../../types/informationTypes";

export function EntityListRenderer({ data, onEntityClick, onEntityContextMenu, resolveEntity }: RendererProps) {
  const d = data as EntityListData;
  if (!d?.items?.length) return null;

  return (
    <div className="renderer-entity-list">
      {d.items.map((item, i) => {
        const kind = d.itemKind ?? item.libraryKind;
        const resolved = kind ? resolveEntity?.(kind, item.name) : undefined;
        const entityId = item.libraryId ?? resolved?.id;

        return (
          <div
            key={i}
            className={`entity-list-item${item.libraryId ? " clickable" : ""}`}
            onClick={() => item.libraryId && onEntityClick?.(item.libraryKind ?? "track", item.libraryId, item.name)}
            onContextMenu={(e) => {
              if (!kind || !onEntityContextMenu) return;
              e.preventDefault();
              onEntityContextMenu(e, {
                kind,
                id: entityId,
                name: item.name,
                artistName: item.subtitle ?? null,
              });
            }}
          >
            {item.image && <img src={item.image} alt="" className="entity-list-image" />}
            <div className="entity-list-text">
              <span className="entity-list-name">{item.name}</span>
              {item.subtitle && <span className="entity-list-subtitle">{item.subtitle}</span>}
            </div>
            {item.match != null && (
              <div className="entity-list-match">
                <div className="match-bar" style={{ width: `${Math.round(item.match * 100)}%` }} />
              </div>
            )}
            {item.url && (
              <a href="#" className="entity-list-link" onClick={(e) => { e.preventDefault(); e.stopPropagation(); openUrl(item.url!); }}>
                ▶
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}
