import { useState, useRef } from "react";
import type { InteractiveSearchResult } from "../../types/plugin";
import type { DownloadPlan } from "../../utils/downloadPlan";
import { formatDuration } from "../../utils";
import { resolveImageUrl } from "../../utils/resolveImageUrl";
import { TrackArtFallback } from "../TrackArtFallback";
import { useAssignRef } from "../../hooks/useLatestRef";

/** The provider's free-text search behind "Choose a different match…". Its
 *  state lives in the modal (this hook), not in the step, so going back to the
 *  configure step and opening the search again keeps the results instead of
 *  asking the provider a second time. */
export function useMatchSearch(search: DownloadPlan["search"], initialQuery: string) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<InteractiveSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ran, setRan] = useState(false);
  const searchRef = useRef(search);
  useAssignRef(searchRef, search);

  async function run(q = query) {
    const fn = searchRef.current;
    if (!fn) return;
    setRan(true);
    setSearching(true);
    setError(null);
    setResults([]);
    try {
      setResults(await fn(q, 10));
    } catch (e) {
      setError(String(e));
    } finally {
      setSearching(false);
    }
  }

  /** Search once, the first time the step is opened. */
  function open() {
    if (!ran) run();
  }

  return { query, setQuery, results, searching, error, run, open };
}

export function MatchSearchStep({
  providerName,
  state,
  onPick,
  onBack,
}: {
  providerName: string;
  state: ReturnType<typeof useMatchSearch>;
  onPick: (match: InteractiveSearchResult) => void;
  onBack: () => void;
}) {
  const { query, setQuery, results, searching, error, run } = state;
  // Columns appear only when some result has something to put in them.
  const hasArt = results.some((r) => r.coverUrl);
  const hasMeta = results.some((r) => r.artistName || r.albumTitle);
  const hasDuration = results.some((r) => r.durationSecs);

  return (
    <>
      <div className="dl-search-field">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") run(); }}
          placeholder={`Search ${providerName}...`}
        />
        <button onClick={() => run()} disabled={searching}>Search</button>
      </div>
      {searching ? (
        <div className="dl-loading"><div className="ds-spinner" /><span>Searching {providerName}...</span></div>
      ) : error ? (
        <div className="dl-error">{error}</div>
      ) : results.length === 0 ? (
        <div className="dl-empty">No matches found on {providerName}</div>
      ) : (
        <div className="dl-results">
          {results.map((t) => (
            <div key={t.id} className="dl-result" onClick={() => onPick(t)}>
              {hasArt && (
                <div className="dl-result-art">
                  {t.coverUrl ? (
                    <img src={resolveImageUrl(t.coverUrl) ?? undefined} alt="" />
                  ) : (
                    <div className="dl-art-placeholder">
                      <TrackArtFallback track={{ format: null, path: null }} size={18} />
                    </div>
                  )}
                </div>
              )}
              <div className="dl-result-info">
                <span className="dl-result-title">{t.title}</span>
                {hasMeta && (
                  <span className="dl-result-meta">
                    {t.artistName}{t.albumTitle ? ` — ${t.albumTitle}` : ""}
                  </span>
                )}
              </div>
              {hasDuration && (
                <span className="dl-result-duration">
                  {t.durationSecs ? formatDuration(t.durationSecs) : ""}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="dl-actions">
        <button onClick={onBack}>Back</button>
      </div>
    </>
  );
}
