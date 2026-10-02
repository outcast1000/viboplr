import { useMemo, type ReactNode } from "react";
import type { Track } from "../types";
import { useDetailActions } from "../contexts/DetailViewContext";
import { useEntityTags } from "../hooks/useEntityTags";
import { useCommunityTagsForTracks } from "../hooks/useCommunityTags";
import { appendCommunityTags } from "../utils/tagSuggestions";
import TagEditor from "./TagEditor";
import "./EntityTagPanel.css";

interface EntityTagPanelProps {
  /** The entity's tracks (album's tracks, or all of an artist's tracks). */
  tracks: Track[];
  /** Render bare (no section wrapper or title) — for hosting inside a tab. */
  embedded?: boolean;
  /** One line above the editor saying what the tab does (a full Tags tab). */
  intro?: ReactNode;
  /** Input above the chips (see TagEditor `addAreaFirst`). */
  addFirst?: boolean;
  /** Shown when there are no tags yet (see TagEditor `emptyText`). */
  emptyText?: string;
}

/**
 * Editable Tags panel for an album or artist detail page. Shows the union of
 * tags across the entity's tracks (full chips) plus partial chips with a count
 * and fill-to-all, and applies/removes tags across the whole track set — DB-only
 * and optimistic. Reuses the shared TagEditor; refreshes library tag state after
 * each write so the Library tags tab and counts stay current.
 */
export function EntityTagPanel({ tracks, embedded, intro, addFirst, emptyText }: EntityTagPanelProps) {
  const actions = useDetailActions();
  const libraryTrackCount = tracks.filter((t) => t.id != null).length;
  const hasTracks = libraryTrackCount > 0;
  // "to all tracks" signals the bulk nature on album/artist; a single track
  // (Track Details) reads better without it.
  const placeholder = libraryTrackCount === 1 ? "Add a tag…" : "Add a tag to all tracks…";

  const { applied, partial, loading, pending, apply, fillToAll, remove } = useEntityTags(
    tracks,
    { onMutated: actions.refreshLibraryTags },
  );

  const { tags: communityTags, loading: communityLoading } = useCommunityTagsForTracks({
    tracks,
    invokeInfoFetch: actions.invokeInfoFetch,
    enabled: hasTracks,
    pluginsLoaded: actions.pluginsLoaded,
  });

  const suggestions = useMemo(
    () => appendCommunityTags(actions.tagSuggestionPool, communityTags),
    [actions.tagSuggestionPool, communityTags],
  );

  return (
    <div className={embedded ? "entity-tag-panel" : "section-wide entity-tag-panel"}>
      {!embedded && <div className="section-title">Tags</div>}
      {intro && hasTracks && <p className="entity-tag-panel-intro">{intro}</p>}
      {!hasTracks ? (
        <span className="entity-tag-panel-hint">No library tracks to tag.</span>
      ) : loading ? (
        <span className="ds-spinner ds-spinner--sm" aria-label="Loading tags" />
      ) : (
        <TagEditor
          tags={applied}
          partialTags={partial}
          suggestions={suggestions}
          onAdd={apply}
          onFillToAll={fillToAll}
          onRemove={remove}
          onChipLabelClick={actions.navigateToTagByName}
          inlineSuggestions
          addAreaFirst={addFirst}
          emptyText={emptyText}
          disabled={pending}
          placeholder={placeholder}
          suggestedPills={communityTags.map((t) => t.name)}
          suggestedPillsLabel="Last.fm"
          suggestedPillsLoading={communityLoading}
        />
      )}
    </div>
  );
}
