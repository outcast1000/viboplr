import { ViewSearchBar } from "./ViewSearchBar";
import "./DetailTrackFilter.css";

interface DetailTrackFilterProps {
  query: string;
  onQueryChange: (query: string) => void;
  /** Rows the list draws unfiltered (library + "Not in library"). */
  total: number;
  /** Rows left after the filter. */
  shown: number;
}

/** The filter box above an artist / album / tag page's track list. The page
 *  decides whether to render it (`showDetailFilter`); this only draws it. */
export function DetailTrackFilter({ query, onQueryChange, total, shown }: DetailTrackFilterProps) {
  return (
    <ViewSearchBar
      className="detail-track-filter"
      query={query}
      onQueryChange={onQueryChange}
      placeholder={`Filter ${total} tracks`}
    >
      {query.trim() && <span className="detail-track-filter-count">{shown} of {total}</span>}
    </ViewSearchBar>
  );
}
