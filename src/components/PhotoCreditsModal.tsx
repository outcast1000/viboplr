import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { PhotoSlide } from "../utils/nowPlayingArt";
import { resolveImageSrc } from "../utils/resolveImageUrl";
import "./PhotoCreditsModal.css";

/**
 * Every photo "Show additional images" is dealing for this song, with its
 * credit (author · year · source / licence) and a link to its page. The credits
 * live here rather than over the picture (owner decision, 2026-11-09): the
 * slideshow stays a picture, and the attribution Commons licences and Getty's
 * terms ask for is one click away, always in the same place.
 *
 * Portalled to the body so the audio fullscreen overlay's stacking context
 * can't hold it under its own layers. Escape or Close dismisses; never a click
 * on the overlay (modal convention).
 */
export function PhotoCreditsModal({ photos, currentUrl, onClose }: {
  photos: readonly PhotoSlide[];
  /** The photo on screen, marked and scrolled to. */
  currentUrl: string | null;
  onClose: () => void;
}) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const currentRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "nearest" });
  }, []);

  return createPortal(
    <div className="ds-modal-overlay">
      <div className="ds-modal ds-modal--lg photo-credits-modal" role="dialog" aria-labelledby="photo-credits-title">
        <h2 className="ds-modal-title" id="photo-credits-title">Photos</h2>
        <p className="photo-credits-intro">
          {photos.length === 1 ? "1 photo" : `${photos.length} photos`} in this song's slideshow, after its cover and artist image.
        </p>
        <ul className="photo-credits-list">
          {photos.map((p) => {
            const current = p.url === currentUrl;
            return (
              <li
                key={p.url}
                ref={current ? currentRef : undefined}
                className={`photo-credits-row${current ? " photo-credits-row--current" : ""}`}
                aria-current={current ? "true" : undefined}
              >
                <img className="photo-credits-thumb" src={resolveImageSrc(p.url) ?? p.url} alt="" loading="lazy" />
                <div className="photo-credits-text">
                  <div className="photo-credits-credit">{p.credit ?? "No credit given by the source"}</div>
                  {current && <div className="photo-credits-now">On screen now</div>}
                </div>
                {p.pageUrl && (
                  <button
                    type="button"
                    className="ds-btn ds-btn--ghost ds-btn--sm"
                    title={p.pageUrl}
                    onClick={() => {
                      openUrl(p.pageUrl!).catch((e) => console.error("Failed to open photo page:", e));
                    }}
                  >
                    Open page
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={onClose} autoFocus>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
