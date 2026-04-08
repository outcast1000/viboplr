import type { RendererProps } from "./index";
import type { EntityListData } from "../../types/informationTypes";

export function EntityCardsRenderer({ data, onEntityClick, resolveEntity }: RendererProps) {
  const d = data as EntityListData;
  if (!d?.items?.length) return null;

  return (
    <div className="similar-artists-row">
      {d.items.map((item, i) => {
        const resolved = resolveEntity?.(item.libraryKind ?? "artist", item.name);
        const clickable = !!resolved?.id;
        return (
          <div
            key={i}
            className={`similar-artist-card${clickable ? " clickable" : ""}`}
            onClick={() => clickable && onEntityClick?.(item.libraryKind ?? "artist", resolved!.id, item.name)}
          >
            <div className="similar-artist-avatar">
              {resolved?.imageSrc ? (
                <img src={resolved.imageSrc} alt={item.name} />
              ) : (
                item.name[0]?.toUpperCase() ?? "?"
              )}
            </div>
            <span className="similar-artist-name" title={item.name}>{item.name}</span>
            {item.match != null && (
              <span className="similar-artist-match">{Math.round(item.match * 100)}%</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
