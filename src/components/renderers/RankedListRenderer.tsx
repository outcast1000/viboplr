import type { RendererProps } from "./index";
import type { RankedListData } from "../../types/informationTypes";

export function RankedListRenderer({ data, onEntityClick }: RendererProps) {
  const d = data as RankedListData;
  if (!d?.items?.length) return null;

  const maxVal = d.items.reduce((m, it) => Math.max(m, it.maxValue ?? it.value), 0);

  return (
    <div className="renderer-ranked-list">
      {d.items.map((item, i) => (
        <div
          key={i}
          className={`ranked-list-item${item.libraryId ? " clickable" : ""}`}
          onClick={() => item.libraryId && onEntityClick?.(item.libraryKind ?? "track", item.libraryId, item.name)}
        >
          <span className="ranked-list-rank">{i + 1}</span>
          <div className="ranked-list-text">
            <span className="ranked-list-name">{item.name}</span>
            {item.subtitle && <span className="ranked-list-subtitle">{item.subtitle}</span>}
          </div>
          <div className="ranked-list-bar-container">
            <div className="ranked-list-bar" style={{ width: maxVal > 0 ? `${(item.value / maxVal) * 100}%` : "0%" }} />
          </div>
          <span className="ranked-list-value">{item.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}
