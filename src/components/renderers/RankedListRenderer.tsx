import type { RendererProps } from "./index";
import type { RankedListData } from "../../types/informationTypes";

function formatCount(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    if (v >= 100) return `${Math.round(v)}M`;
    if (v >= 10) return `${v.toFixed(1).replace(/\.0$/, "")}M`;
    return `${v.toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    if (v >= 100) return `${Math.round(v)}K`;
    if (v >= 10) return `${v.toFixed(1).replace(/\.0$/, "")}K`;
    return `${v.toFixed(2).replace(/\.?0+$/, "")}K`;
  }
  return String(n);
}

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
          <span className="ranked-list-popularity">
            <span className="ranked-list-popularity-fill" style={{ width: maxVal > 0 ? `${(item.value / maxVal) * 100}%` : "0%" }} />
            <span className="ranked-list-popularity-count">{formatCount(item.value)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
