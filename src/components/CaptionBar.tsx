import { getCurrentWindow } from "@tauri-apps/api/window";
import { WindowControls } from "./WindowControls";
import { CentralSearchDropdown } from "./CentralSearchDropdown";
import type { ResyncProgress, ResyncComplete } from "../hooks/useEventListeners";

interface CaptionBarProps {
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  centralSearch: {
    query: string;
    setQuery: (q: string) => void;
    results: any;
    items: any;
    isOpen: boolean;
    highlightedIndex: number;
    handleKeyDown: (e: React.KeyboardEvent) => void;
    handleResultClick: (item: any) => void;
    close: () => void;
  };
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  albumImages: Record<number, string | null>;
  artistImages: Record<number, string | null>;
  onFetchAlbumImage: (album: any) => void;
  onFetchArtistImage: (artist: any) => void;
  onToggleMiniMode: () => void;
  onToggleHelp: () => void;
  minimizeToMiniPlayer: boolean;
  resyncProgress: ResyncProgress | null;
  resyncComplete: ResyncComplete | null;
  onNavigateToCollections: () => void;
}

export function CaptionBar({
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  centralSearch,
  searchInputRef,
  albumImages,
  artistImages,
  onFetchAlbumImage,
  onFetchArtistImage,
  onToggleMiniMode,
  onToggleHelp,
  minimizeToMiniPlayer,
  resyncProgress,
  resyncComplete,
  onNavigateToCollections,
}: CaptionBarProps) {
  function handleCaptionDoubleClick(e: React.MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("input")) return;
    getCurrentWindow().toggleMaximize();
  }

  return (
    <div className="search-bar" data-tauri-drag-region onDoubleClick={handleCaptionDoubleClick}>
      <WindowControls position="left" minimizeToMiniPlayer={minimizeToMiniPlayer} onMinimizeToMini={onToggleMiniMode} />
        <div className="caption-brand" data-tauri-drag-region>
          <svg width="34" height="34" viewBox="0 0 512 512" fill="none" style={{ marginRight: "-6px" }}>
            <defs>
              <linearGradient id="captionVGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#FF6B6B"/>
                <stop offset="100%" stopColor="#E91E8A"/>
              </linearGradient>
            </defs>
            <circle cx="256" cy="256" r="230" fill="none" stroke="url(#captionVGrad)" strokeWidth="6" opacity="0.15"/>
            <circle cx="256" cy="256" r="190" fill="none" stroke="url(#captionVGrad)" strokeWidth="4" opacity="0.1"/>
            <path d="M120,110 L256,400 L392,110" fill="none" stroke="url(#captionVGrad)" strokeWidth="56" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="256" cy="400" r="16" fill="url(#captionVGrad)" opacity="0.6"/>
          </svg>
          <span className="caption-brand-text">iboPLR</span>
        </div>
        <button
          className="g-btn g-btn-sm"
          disabled={!canGoBack}
          onClick={onGoBack}
          title="Go back (Alt+Left)"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <button
          className="g-btn g-btn-sm"
          disabled={!canGoForward}
          onClick={onGoForward}
          title="Go forward (Alt+Right)"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 6 15 12 9 18" />
          </svg>
        </button>
        {(resyncProgress || resyncComplete) && (
          <button
            className={`caption-sync-indicator${resyncComplete?.error ? " caption-sync-error" : resyncComplete ? " caption-sync-done" : ""}`}
            onClick={(e) => { e.stopPropagation(); onNavigateToCollections(); }}
            title={resyncComplete?.error ? `Sync failed: ${resyncComplete.error}` : resyncProgress ? `${resyncProgress.scanned}/${resyncProgress.total}` : "Sync complete"}
          >
            {resyncComplete?.error ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
            ) : resyncComplete ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            ) : (
              <svg className="caption-sync-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
              </svg>
            )}
            <span className="caption-sync-text">
              {resyncComplete?.error ? "Sync failed" : resyncComplete ? "Sync complete" : resyncProgress?.collectionName}
            </span>
          </button>
        )}
        <CentralSearchDropdown
          query={centralSearch.query}
          onQueryChange={centralSearch.setQuery}
          results={centralSearch.results}
          items={centralSearch.items}
          isOpen={centralSearch.isOpen}
          highlightedIndex={centralSearch.highlightedIndex}
          onKeyDown={centralSearch.handleKeyDown}
          onResultClick={centralSearch.handleResultClick}
          onClose={centralSearch.close}
          inputRef={searchInputRef}
          albumImages={albumImages}
          artistImages={artistImages}
          onFetchAlbumImage={onFetchAlbumImage}
          onFetchArtistImage={onFetchArtistImage}
        />
        <div className="caption-spacer" />
        <button
          className="g-btn g-btn-sm"
          onClick={onToggleHelp}
          title="Keyboard shortcuts"
        >
          {"?"}
        </button>
        <button
          className="g-btn g-btn-rect"
          onClick={onToggleMiniMode}
          title="Mini Player"
        >
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="14" width="10" height="8" rx="1" />
            <path d="M12 8h8a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h2" />
          </svg>
          <span>Mini Player</span>
        </button>
        <WindowControls position="right" minimizeToMiniPlayer={minimizeToMiniPlayer} onMinimizeToMini={onToggleMiniMode} />
      </div>
  );
}
