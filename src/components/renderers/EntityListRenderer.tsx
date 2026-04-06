import type { RendererProps } from "./index";
import type { EntityListData } from "../../types/informationTypes";

export function EntityListRenderer({ data, onEntityClick }: RendererProps) {
  const d = data as EntityListData;
  if (!d?.items?.length) return null;

  return (
    <div className="renderer-entity-list">
      {d.items.map((item, i) => (
        <div
          key={i}
          className={`entity-list-item${item.libraryId ? " clickable" : ""}`}
          onClick={() => item.libraryId && onEntityClick?.(item.libraryKind ?? "track", item.libraryId, item.name)}
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
            <a href={item.url} target="_blank" rel="noopener noreferrer" className="entity-list-link" onClick={(e) => e.stopPropagation()}>
              ↗
            </a>
          )}
        </div>
      ))}
    </div>
  );
}
