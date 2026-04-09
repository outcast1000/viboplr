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

export function RankedListRenderer({ data, onEntityClick, onAction, resolveEntity }: RendererProps) {
  const d = data as RankedListData;
  if (!d?.items?.length) return null;

  const maxVal = d.items.reduce((m, it) => Math.max(m, it.maxValue ?? it.value), 0);

  return (
    <div className="renderer-ranked-list">
      {d.items.map((item, i) => {
        const resolved = item.libraryKind === "track" && !item.libraryId && resolveEntity
          ? resolveEntity("track", item.subtitle ? `${item.name}|||${item.subtitle}` : item.name)
          : undefined;
        const trackId = item.libraryId ?? resolved?.id;

        return (
          <div
            key={i}
            className={`ranked-list-item${(item.libraryId || resolved?.id) ? " clickable" : ""}`}
            onClick={() => {
              const id = item.libraryId ?? resolved?.id;
              if (id) onEntityClick?.(item.libraryKind ?? "track", id, item.name);
            }}
          >
            <span className="ranked-list-rank">{i + 1}</span>
            {item.libraryKind === "track" && (
              <div className="ranked-list-actions">
                {trackId ? (
                  <button
                    className="ranked-list-action-btn"
                    title="Play"
                    onClick={(e) => { e.stopPropagation(); onAction?.("play-track", { id: trackId }); }}
                  >&#9654;</button>
                ) : (
                  <button
                    className="ranked-list-action-btn"
                    title="Search on YouTube"
                    onClick={(e) => { e.stopPropagation(); onAction?.("youtube-search", { name: item.name, artist: item.subtitle }); }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.38.55A3.02 3.02 0 0 0 .5 6.19 31.8 31.8 0 0 0 0 12a31.8 31.8 0 0 0 .5 5.81 3.02 3.02 0 0 0 2.12 2.14c1.88.55 9.38.55 9.38.55s7.5 0 9.38-.55a3.02 3.02 0 0 0 2.12-2.14A31.8 31.8 0 0 0 24 12a31.8 31.8 0 0 0-.5-5.81zM9.75 15.02V8.98L15.5 12l-5.75 3.02z"/></svg>
                  </button>
                )}
              </div>
            )}
            <div className="ranked-list-text">
              <span className="ranked-list-name">{item.name}</span>
              {item.subtitle && <span className="ranked-list-subtitle">{item.subtitle}</span>}
            </div>
            <span className="ranked-list-popularity">
              <span className="ranked-list-popularity-fill" style={{ width: maxVal > 0 ? `${(item.value / maxVal) * 100}%` : "0%" }} />
              <span className="ranked-list-popularity-count">{formatCount(item.value)}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
