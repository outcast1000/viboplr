import { memo, type ReactNode } from "react";

interface FreezeWhileHiddenProps {
  hidden: boolean;
  children: ReactNode;
}

/**
 * Skips reconciliation of `children` while `hidden` — for the always-mounted,
 * display-toggled views (Home / Library / Extensions), which are kept mounted
 * to preserve accumulated state (loaded pages, scroll position, fetched
 * galleries) but were still re-rendered by every App-level state change. With
 * three heavy views mounted at once, that made each root render reconcile the
 * whole UI; freezing the hidden ones caps the blast radius at the visible view.
 *
 * How: the memo comparator reports "props equal" only when the subtree is
 * hidden in both the previous and next render. So the visible view re-renders
 * exactly as before (no prop-stabilization contract to uphold), the transition
 * renders that apply/remove `display: none` still happen, and on unhide the
 * subtree re-renders once with fresh props — a frozen view can never be
 * interacted with, so the stale props it holds meanwhile are unobservable.
 *
 * Two things deliberately still work while frozen: the child's own setState
 * (memo only blocks parent-driven renders) and context updates (which punch
 * through memo). One caveat for callers: a "command" prop that replaces its
 * payload on every bump (rather than accumulating) can lose intermediate
 * payloads while frozen — see the deleted-track batches App.tsx feeds
 * SearchView, which accumulate for exactly this reason.
 */
export const FreezeWhileHidden = memo(
  function FreezeWhileHidden({ children }: FreezeWhileHiddenProps) {
    return <>{children}</>;
  },
  (prev, next) => prev.hidden && next.hidden,
);
