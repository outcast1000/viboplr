import type { RendererProps } from "./index";
import type { RankedListData } from "../../types/informationTypes";
import { formatCompactCount } from "../../utils/formatCount";

export function RankedListRenderer({ data, onEntityClick, onAction, resolveEntity, onTrackContextMenu }: RendererProps) {
  const d = data as RankedListData;
  if (!d?.items?.length) return null;

  const maxVal = d.items.reduce((m, it) => Math.max(m, it.maxValue ?? it.value), 0);
  const isTrackItem = (item: RankedListData["items"][number]) =>
    item.libraryKind === "track" || (!item.libraryKind && !!item.subtitle);
  // The playable rows, in order — what a row click queues. Library or not:
  // the stream resolvers find each one's source at play time.
  const trackItems = d.items.filter(isTrackItem);

  return (
    <div className="renderer-ranked-list">
      {d.items.map((item, i) => {
        const isTrack = isTrackItem(item);
        const resolved = isTrack && !item.libraryId && resolveEntity
          ? resolveEntity("track", item.subtitle ? `${item.name}|||${item.subtitle}` : item.name)
          : undefined;
        const trackId = item.libraryId ?? resolved?.id;

        return (
          <div
            key={i}
            className={`ranked-list-item${isTrack || item.libraryId ? " clickable" : ""}`}
            title={isTrack ? "Play from here" : undefined}
            onClick={() => {
              if (isTrack) {
                onAction?.("play-list", {
                  items: trackItems.map(t => ({ name: t.name, artist: t.subtitle })),
                  startIndex: trackItems.indexOf(item),
                });
                return;
              }
              if (item.libraryId) onEntityClick?.(item.libraryKind ?? "track", item.libraryId, item.name);
            }}
            onContextMenu={isTrack && onTrackContextMenu ? (e) => {
              e.preventDefault();
              onTrackContextMenu(e, { trackId: trackId ?? undefined, title: item.name, artistName: item.subtitle ?? null });
            } : undefined}
          >
            {isTrack && (
              <div className="ranked-list-actions">
                <button
                  className="track-row-action track-row-action-play"
                  title="Play"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAction?.("play-track", { name: item.name, artist: item.subtitle });
                  }}
                >
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82z"/></svg>
                </button>
                <button
                  className="track-row-action track-row-action-enqueue"
                  title="Enqueue"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAction?.("enqueue-track", { name: item.name, artist: item.subtitle });
                  }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
                </button>
              </div>
            )}
            <span className="ranked-list-rank">{i + 1}</span>
            <div className="ranked-list-text">
              <span className="ranked-list-name">{item.name}</span>
              {item.subtitle && <><span className="ranked-list-sep"> — </span><span className="ranked-list-subtitle">{item.subtitle}</span></>}
            </div>
            <span className="ranked-list-popularity">
              <span className="ranked-list-popularity-fill" style={{ width: maxVal > 0 ? `${(item.value / maxVal) * 100}%` : "0%" }} />
              <span className="ranked-list-popularity-count">{formatCompactCount(item.value)}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
