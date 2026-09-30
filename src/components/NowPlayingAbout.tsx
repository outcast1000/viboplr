import { useState } from "react";
import type { MouseEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { renderers } from "./renderers";
import type { AboutTabId, NowPlayingAboutData } from "../hooks/useNowPlayingAbout";

/** Which tab to show: the user's pick while it still exists, otherwise the first
    listed one (Song → Artist → Album; only tabs with text are listed). */
export function pickAboutTab(data: NowPlayingAboutData, chosen: AboutTabId | null): AboutTabId | null {
  if (chosen && data.tabs.some((t) => t.id === chosen)) return chosen;
  return data.tabs[0]?.id ?? null;
}

/** The reading panel that takes the lyrics column's place in the Now Playing
    view: song / artist / album prose from the info-type providers. Deliberately
    minimal — a quiet tab switch (only when there is more than one thing to read)
    and the text. No provider badges, refresh buttons or lists: the detail pages
    carry all of that, and the now-playing bar's artist/album links lead there. */
export function NowPlayingAbout({ data, trackKey }: { data: NowPlayingAboutData; trackKey: string }) {
  // Keyed to the track (previous-value-in-state) so every track opens on its
  // best tab rather than inheriting the last track's pick.
  const [choice, setChoice] = useState<{ key: string; tab: AboutTabId } | null>(null);
  const chosen = choice?.key === trackKey ? choice.tab : null;
  const activeId = pickAboutTab(data, chosen);
  // The first tab shown is pinned as though it had been clicked: providers
  // answer at different speeds, and a Song text landing after the artist bio
  // must not swap the panel out from under someone already reading. (Setting
  // state during render is React's documented previous-value pattern; the
  // guard makes it run once per track.)
  if (activeId && chosen === null) setChoice({ key: trackKey, tab: activeId });
  const active = data.tabs.find((t) => t.id === activeId) ?? null;

  // Provider prose carries links ("Read more on Last.fm"). Followed in place they
  // would navigate the app's own webview away; send them to the browser instead.
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) {
      openUrl(href).catch((err) => console.error("Failed to open link:", err));
    }
  };

  if (!active) {
    return data.pending ? (
      <div className="np-about np-about--empty"><div className="np-lyrics-hint" aria-hidden="true" /></div>
    ) : (
      <div className="np-about np-about--empty">Nothing to read about this track</div>
    );
  }

  return (
    <div className="np-about">
      {data.tabs.length > 1 && (
        <div className="np-about-tabs" role="tablist" aria-label="About">
          {data.tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={t.id === active.id}
              className={`np-about-tab${t.id === active.id ? " is-active" : ""}`}
              onClick={() => setChoice({ key: trackKey, tab: t.id })}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      {/* Keyed so each tab / track change scrolls back to the top and replays the
          entrance, the same way the lyrics panel does. */}
      <div key={`${trackKey}:${active.id}`} className="np-about-scroll" onClick={onClick}>
        {active.entries.map((entry) => {
          const Renderer = renderers[entry.displayKind];
          if (!Renderer) return null;
          return (
            <section key={entry.typeId} className="np-about-entry">
              {/* A heading only when one tab holds several texts — a lone bio
                  under the word "Biography" is the tab label said twice. */}
              {active.entries.length > 1 && <h3 className="np-about-entry-title">{entry.name}</h3>}
              <Renderer data={entry.data} />
            </section>
          );
        })}
      </div>
    </div>
  );
}
