// Shared search UI primitives (split out of SearchView.tsx).
import { useRef, useCallback, type RefCallback } from "react";
import { chainPosition, chainDir, type SortKey } from "../../sortChain";

export function LoadMoreSentinel({ hasMore, loading, onLoadMore }: { hasMore: boolean; loading: boolean; onLoadMore: () => void }) {
  const observerRef = useRef<IntersectionObserver | null>(null);

  const sentinelRef: RefCallback<HTMLDivElement> = useCallback((node) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (!node || !hasMore) return;
    observerRef.current = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) onLoadMore(); },
      { threshold: 0 },
    );
    observerRef.current.observe(node);
  }, [hasMore, onLoadMore]);

  if (!hasMore) return null;
  return (
    <div ref={sentinelRef} className="search-view-load-more">
      {loading && <span className="ds-spinner ds-spinner--sm" />}
    </div>
  );
}

export function SortButton({ label, field, chain, onClick }: {
  label: string;
  field: string;
  chain: SortKey[];
  onClick: (field: string, e: React.MouseEvent) => void;
}) {
  const pos = chainPosition(chain, field);
  const dir = chainDir(chain, field);
  const arrow = dir === "asc" ? " ▲" : dir === "desc" ? " ▼" : "";
  return (
    <button
      className={`sort-btn${pos >= 0 ? " active" : ""}`}
      onClick={e => onClick(field, e)}
    >
      {label}{arrow}
      {chain.length > 1 && pos >= 0 && <span className="sort-btn-badge">{pos + 1}</span>}
    </button>
  );
}
