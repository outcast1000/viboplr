import { useEffect, useRef, useState } from "react";
import type { HomeShelfItem, HomeShelfResult, HomeShelfDisplayKind } from "../types/plugin";
import type { ResolvedShelf } from "../hooks/useHome";
import {
  useHome,
  DEFAULT_SHELF_ORDER,
  RADIO_SHELF_ID,
  buildRadioShelf,
  mergeShelfOrder,
  orderResolvedShelves,
  isShelfVisible,
} from "../hooks/useHome";
import { useImageCache } from "../hooks/useImageCache";
import { HeroCarousel } from "./HeroCarousel";
import { HomeShelf } from "./HomeShelf";
import { CustomizeHomeModal } from "./CustomizeHomeModal";
import { store } from "../store";
import { seedProfileShelfVisibility, type OnboardingProfile } from "./onboardingSteps";
import "./HomeView.css";

export interface HomeViewProps {
  style?: React.CSSProperties;
  isVisible: boolean;
  pluginShelves: Array<{
    pluginId: string;
    shelfId: string;
    title: string;
    displayKind: HomeShelfDisplayKind;
    limit: number;
  }>;
  invokePluginShelf: (pluginId: string, shelfId: string, limit: number) => Promise<HomeShelfResult>;
  pluginsLoaded: boolean;
  // Ids of currently loaded & active plugins — lets useHome keep the cached
  // shelves of a plugin that registers them late (rather than pruning them).
  activePluginIds: Set<string>;
  restoredRef: React.RefObject<boolean>;
  // Bumped by the host when a collection resync changes the library, so Home
  // re-fetches its content shelves (see useHome).
  libraryRevision: number;
  onShelfItemClick: (shelf: ResolvedShelf, item: HomeShelfItem) => void;
  onShelfItemContextMenu: (shelf: ResolvedShelf, item: HomeShelfItem, e: React.MouseEvent) => void;
  onShelfItemPlay: (shelf: ResolvedShelf, item: HomeShelfItem) => void;
  /** How many music sources exist — decides which empty state Home shows. */
  collectionCount: number;
  /** Sidebar views of the active plugins. With no collections these are the
   *  user's actual sources, so the empty state offers them instead of asking
   *  for a folder they deliberately don't have. */
  pluginViews: Array<{ pluginId: string; viewId: string; label: string }>;
  onOpenPluginView: (pluginId: string, viewId: string) => void;
  /** Live scan/sync of a collection, so a bare Home reads as "working", not "broken". */
  indexing: { collectionName: string; kind: "scan" | "sync"; scanned: number; total: number } | null;
  onAddFolder: () => void;
  onConnectServer: () => void;
  onBrowseExtensions: () => void;
  onRunSetup: () => void;
  /** Chosen usage profile, which may switch on the shelves that profile
   *  implies (see `seedProfileShelfVisibility`). Defaults to "normal" before
   *  restore, which seeds nothing — so an unrestored render is a no-op rather
   *  than a wrong seed. */
  onboardingProfile: OnboardingProfile;
}

export function HomeView(props: HomeViewProps) {
  const albumImages = useImageCache("album");
  const artistImages = useImageCache("artist");

  const [visibility, setVisibility] = useState<Record<string, boolean>>({});
  // User-defined order of the built-in shelves; plugin shelves always follow.
  const [shelfOrder, setShelfOrder] = useState<string[]>(DEFAULT_SHELF_ORDER);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  // Own hydration flag for visibility/order, separate from the app-wide
  // `restoredRef`. HomeView mounts (always-on, just display:none'd) well before
  // `restoredRef` flips — that guard can stay false for several seconds during
  // startup (e.g. the native-engine capability probe). If a user opens Customize
  // and toggles a shelf inside that window, gating the persist effects on the
  // slow global flag silently drops the edit (never retried), which reads as
  // "my shelf configuration got reset" on the next launch. This flag instead
  // reflects only this component's own (fast, local) restore read.
  const [configHydrated, setConfigHydrated] = useState(false);

  // Restore visibility + order on mount
  useEffect(() => {
    (async () => {
      try {
        const v = (await store.get<Record<string, boolean>>("homeShelfVisibility")) ?? {};
        setVisibility(v);
        const ord = await store.get<string[]>("homeShelfOrder");
        // Merge with defaults so brand-new built-ins (e.g. Radio) land in their
        // default position instead of disappearing or being tacked on the end.
        if (ord && ord.length) setShelfOrder(mergeShelfOrder(ord));
      } finally {
        setConfigHydrated(true);
      }
    })();
  }, []);

  // Switch on the shelves the chosen usage profile implies — currently Video →
  // "Recently added tracks", the only built-in shelf that surfaces videos at
  // all (videos have no album_id, so "Recently added albums" can never show
  // one, and it is the album shelf that is visible by default).
  //
  // This lives here rather than in the wizard's close handler because this
  // component owns `visibility`: a store write from outside would be silently
  // reverted by the persist effect below the moment the user next toggled
  // anything, since that write would carry this component's stale state.
  // Seeding through setVisibility keeps one owner and persists via the same
  // path as a manual toggle. `seedProfileShelfVisibility` returns null when
  // there is nothing to fill, and returning `v` unchanged makes React bail out
  // of the update, so this can run on every profile change without churn.
  useEffect(() => {
    if (!configHydrated) return;
    const profile = props.onboardingProfile;
    setVisibility((v) => seedProfileShelfVisibility(profile, v) ?? v);
  }, [configHydrated, props.onboardingProfile]);

  // Persist visibility
  useEffect(() => {
    if (!configHydrated) return;
    store.set("homeShelfVisibility", visibility);
  }, [visibility, configHydrated]);

  // Persist order
  useEffect(() => {
    if (!configHydrated) return;
    store.set("homeShelfOrder", shelfOrder);
  }, [shelfOrder, configHydrated]);

  const { radioStations, shelves, refresh, isLoading, hydrated } = useHome({
    isVisible: props.isVisible,
    pluginShelves: props.pluginShelves,
    invokePluginShelf: props.invokePluginShelf,
    pluginsLoaded: props.pluginsLoaded,
    activePluginIds: props.activePluginIds,
    visibility,
    shelfOrder,
    restoredRef: props.restoredRef,
    libraryRevision: props.libraryRevision,
  });

  function toggleShelf(id: string) {
    // Store the explicit opposite of the current effective visibility, so toggling
    // works whether the shelf was on/off by default or by a prior explicit setting.
    setVisibility((prev) => ({ ...prev, [id]: !isShelfVisible(id, prev) }));
  }

  // "Have we finished looking?" — the empty state must not flash in the gap
  // between mount and the first fetch (shelves are empty and isLoading is still
  // false in that window), but it must not wait forever either: a snapshot
  // that's still fresh skips the refresh entirely, so a load may never start.
  // Settle on a completed load, or on a short grace period after hydration with
  // nothing loading.
  const [settled, setSettled] = useState(false);
  const wasLoading = useRef(false);
  useEffect(() => {
    if (wasLoading.current && !isLoading) setSettled(true);
    wasLoading.current = isLoading;
  }, [isLoading]);
  useEffect(() => {
    if (!hydrated || settled || isLoading) return;
    const t = setTimeout(() => setSettled(true), 1500);
    return () => clearTimeout(t);
  }, [hydrated, settled, isLoading]);

  const radioVisible = isShelfVisible(RADIO_SHELF_ID, visibility);

  function resetCustomization() {
    setShelfOrder(DEFAULT_SHELF_ORDER);
    setVisibility({});
  }

  // Radio is a shelf like any other (a playlist-cards shelf of stations). Fold it
  // in and order everything by the user's shelf order; whichever shelf lands first
  // is promoted to the hero carousel, the rest render as normal rows.
  //
  // `shelves` reflects the visibility filter as of the last refresh() — toggling
  // a shelf in Customize doesn't itself trigger a refetch (it would just re-fetch
  // data that's already in hand), so re-filter by the *current* visibility here.
  // Without this, toggling a shelf off leaves it on screen until the next
  // refresh (up to 24h later, or a manual ⟳), which reads as "Customize doesn't
  // do anything."
  const visibleShelves = shelves.filter((s) => isShelfVisible(s.id, visibility));
  const radioShelf = radioVisible && radioStations.length ? buildRadioShelf(radioStations) : null;
  const ordered = orderResolvedShelves(radioShelf ? [radioShelf, ...visibleShelves] : visibleShelves, shelfOrder);
  const [heroShelf, ...rowShelves] = ordered;

  const albumImageFor = (name: string, artistName?: string) => albumImages.getImage(name, artistName ?? null);
  const artistImageFor = (name: string) => artistImages.getImage(name);

  return (
    <div className="home-view" style={props.style}>
      <div className="home-view-header">
        <button className="ds-btn ds-btn--ghost ds-btn--sm" onClick={refresh} title="Refresh">⟳ Refresh</button>
        <button className="ds-btn ds-btn--ghost ds-btn--sm" onClick={() => setCustomizeOpen(true)} title="Customize">⚙ Customize</button>
      </div>

      {customizeOpen && (
        <CustomizeHomeModal
          builtInOrder={shelfOrder}
          visibility={visibility}
          onReorder={setShelfOrder}
          onToggle={toggleShelf}
          onReset={resetCustomization}
          onClose={() => setCustomizeOpen(false)}
        />
      )}

      {/* Gated on `settled` for every branch, including the no-sources one:
          `collectionCount` is 0 until the collections fetch resolves, so an
          ungated check would flash "Let's find your music" at every cold start
          for users who do have music. */}
      {ordered.length === 0 && settled && (
        <HomeEmptyState
          collectionCount={props.collectionCount}
          pluginViews={props.pluginViews}
          onOpenPluginView={props.onOpenPluginView}
          indexing={props.indexing}
          onAddFolder={props.onAddFolder}
          onConnectServer={props.onConnectServer}
          onBrowseExtensions={props.onBrowseExtensions}
          onRunSetup={props.onRunSetup}
          onCustomize={() => setCustomizeOpen(true)}
        />
      )}

      {heroShelf && (
        <HeroCarousel
          shelf={heroShelf}
          albumImageFor={albumImageFor}
          artistImageFor={artistImageFor}
          onItemClick={props.onShelfItemClick}
          onItemPlay={props.onShelfItemPlay}
        />
      )}

      {rowShelves.map((shelf) => (
        <HomeShelf
          key={shelf.id}
          shelf={shelf}
          albumImageFor={albumImageFor}
          artistImageFor={artistImageFor}
          onItemClick={props.onShelfItemClick}
          onItemContextMenu={props.onShelfItemContextMenu}
          onItemPlay={props.onShelfItemPlay}
        />
      ))}
    </div>
  );
}

/**
 * What Home shows when it has nothing to show. Home is the startup view, so for
 * a fresh install this is the app's actual first screen — without it the user
 * lands on a blank page with two ghost buttons and no next step.
 *
 * Four distinct situations, in priority order:
 *  1. A scan/sync is running — the shelves are empty only because the library
 *     is still filling. Report progress rather than asking for music again.
 *  2. No collections, but plugin views exist — a streaming setup (e.g. yt-dlp +
 *     Spotify). Nothing is missing; the shelves just have no plays to draw on
 *     yet, so point at the sources the user actually chose.
 *  3. No sources of any kind — the real first-run. Offer the ways in.
 *  4. Sources exist but every shelf came back empty — nothing is wrong; the
 *     content shelves just need listening history, so say so.
 */
function HomeEmptyState({
  collectionCount,
  pluginViews,
  onOpenPluginView,
  indexing,
  onAddFolder,
  onConnectServer,
  onBrowseExtensions,
  onRunSetup,
  onCustomize,
}: {
  collectionCount: number;
  pluginViews: Array<{ pluginId: string; viewId: string; label: string }>;
  onOpenPluginView: (pluginId: string, viewId: string) => void;
  indexing: { collectionName: string; kind: "scan" | "sync"; scanned: number; total: number } | null;
  onAddFolder: () => void;
  onConnectServer: () => void;
  onBrowseExtensions: () => void;
  onRunSetup: () => void;
  onCustomize: () => void;
}) {
  if (indexing) {
    return (
      <div className="home-empty">
        <span className="ds-spinner ds-spinner--lg" />
        <h2 className="home-empty-title">
          {indexing.kind === "sync" ? "Syncing" : "Scanning"} “{indexing.collectionName}”…
        </h2>
        <p className="home-empty-desc">
          {indexing.scanned > 0
            ? `${indexing.scanned.toLocaleString()}${indexing.total > 0 ? ` of ${indexing.total.toLocaleString()}` : ""} tracks so far — Home fills in as they land.`
            : "Home fills in as your tracks land. This runs in the background, so feel free to look around."}
        </p>
      </div>
    );
  }

  // A plugins-only setup: no collection will ever exist, so "Let's find your
  // music" would sit on Home forever telling a correctly-configured user that
  // their setup is unfinished — and pushing them at a folder picker they chose
  // not to use. What they actually need is the first click.
  if (collectionCount === 0 && pluginViews.length > 0) {
    return (
      <div className="home-empty">
        <svg
          className="home-empty-art"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M5 12.55a11 11 0 0 1 14.08 0" />
          <path d="M1.42 9a16 16 0 0 1 21.16 0" />
          <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
          <path d="M12 20h.01" />
        </svg>
        <h2 className="home-empty-title">Pick something to play</h2>
        <p className="home-empty-desc">
          Your sources are plugins, so Home starts out bare — these shelves are
          built from what you play, and they fill in from your first track
          onward. Open a source to get going:
        </p>
        <div className="home-empty-actions">
          {pluginViews.map((v, i) => (
            <button
              key={`${v.pluginId}:${v.viewId}`}
              className={`ds-btn ${i === 0 ? "ds-btn--primary" : "ds-btn--secondary"}`}
              onClick={() => onOpenPluginView(v.pluginId, v.viewId)}
            >
              {v.label}
            </button>
          ))}
        </div>
        <div className="home-empty-alt">
          <button className="ds-btn ds-btn--ghost ds-btn--sm" onClick={onBrowseExtensions}>
            Add more sources
          </button>
          <button className="ds-btn ds-btn--ghost ds-btn--sm" onClick={onAddFolder}>
            Add a local folder
          </button>
        </div>
      </div>
    );
  }

  if (collectionCount === 0) {
    return (
      <div className="home-empty">
        <svg
          className="home-empty-art"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
        <h2 className="home-empty-title">Let's find your music</h2>
        <p className="home-empty-desc">
          Home fills up with radio stations, recent plays and your albums once
          Viboplr knows where your music lives. Point it at a folder, connect a
          server, or add a streaming plugin.
        </p>
        <div className="home-empty-actions">
          <button className="ds-btn ds-btn--primary" onClick={onAddFolder}>
            Add a music folder
          </button>
          <button className="ds-btn ds-btn--secondary" onClick={onConnectServer}>
            Connect a server
          </button>
          <button className="ds-btn ds-btn--ghost" onClick={onBrowseExtensions}>
            Browse plugins
          </button>
        </div>
        <button className="ds-btn ds-btn--ghost ds-btn--sm home-empty-link" onClick={onRunSetup}>
          Or run the setup wizard again
        </button>
      </div>
    );
  }

  return (
    <div className="home-empty">
      <h2 className="home-empty-title">Nothing to show here yet</h2>
      <p className="home-empty-desc">
        Your music is set up, but these shelves are built from what you play —
        start a track and Home fills in. You can also pick which shelves appear.
      </p>
      <div className="home-empty-actions">
        <button className="ds-btn ds-btn--secondary" onClick={onCustomize}>
          Choose shelves
        </button>
        <button className="ds-btn ds-btn--ghost" onClick={onAddFolder}>
          Add another folder
        </button>
      </div>
    </div>
  );
}
