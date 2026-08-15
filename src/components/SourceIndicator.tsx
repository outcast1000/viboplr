import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { QueueTrack, ResolvedSource } from "../types";
import { isLocalTrack } from "../queueEntry";
import { resolutionShorthand } from "../hooks/useNowPlayingInfo";
import { nativeEngine, type EngineMediaInfo } from "../playback/nativeEngine";

/**
 * "Where is this actually coming from?" — the small icon on a playback bar's
 * subtitle line, and the hover panel behind it (source label, decode facts,
 * path/URL, Open folder / Open on <service>).
 *
 * Self-contained on purpose, and that is load-bearing rather than tidiness: the
 * panel is `position: fixed`, so it could in principle be rendered anywhere —
 * but inside **DOM fullscreen** the browser paints only the fullscreened
 * subtree, so a panel hoisted to the app root would silently never appear over
 * fullscreen video. Rendering it next to its own icon keeps it inside whatever
 * subtree the icon is in.
 *
 * Both playback bars mount it. It used to exist only on the docked one, which
 * meant the answer to "why does this sound wrong / where is this streaming
 * from" disappeared exactly when the user went fullscreen.
 */

/** Is the *effective* playback source a local file? Uses the winning resolver's
 *  classified EffectiveSource rather than the track's path scheme: a remote track
 *  served from a local Library copy plays locally, while a local-path track that
 *  fell through to a remote resolver plays remotely. Falls back to the path
 *  scheme when no resolver has reported yet. */
function isEffectivelyLocal(track: { path?: string | null }, resolvedSource: ResolvedSource | null): boolean {
  if (resolvedSource) return resolvedSource.effectiveSource.kind === "local";
  return isLocalTrack(track);
}

function SourceIcon({ s = 11, isLocal }: { s?: number; isLocal: boolean }) {
  if (isLocal) {
    return <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12H2"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/></svg>;
  }
  return <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>;
}

interface SourceIndicatorProps {
  track: QueueTrack;
  resolvedSource: ResolvedSource | null;
}

export function SourceIndicator({ track, resolvedSource }: SourceIndicatorProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [audioProps, setAudioProps] = useState<{ sample_rate?: number; bit_depth?: number; channels?: number; bitrate?: number } | null>(null);
  // Live decode facts from the mpv engine — the ONLY source of quality info for
  // remote/streamed audio and video (audioProps above is lofty, local files only).
  const [mediaInfo, setMediaInfo] = useState<EngineMediaInfo | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch audio properties for the current track (local files only). Reset on
  // track change.
  useEffect(() => {
    setAudioProps(null);
    setMediaInfo(null); // engine facts are (re)fetched when the panel opens
    if (!track.path) return;
    if (!isLocalTrack(track)) return;
    let cancelled = false;
    invoke<{ sample_rate?: number; bit_depth?: number; channels?: number; bitrate?: number }>(
      "get_audio_properties_by_path",
      { path: track.path },
    )
      .then(p => { if (!cancelled) setAudioProps(p); })
      .catch(e => console.error("Failed to load audio properties:", e));
    return () => { cancelled = true; };
  }, [track.path]);

  useEffect(() => () => { if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current); }, []);

  const isLocal = isEffectivelyLocal(track, resolvedSource);
  const es = resolvedSource?.effectiveSource;
  // Prefer the effective source for the local/subsonic cases (so a Library row
  // that streams from Subsonic reads "Subsonic", not "Library").
  const sourceName = es?.kind === "local" ? "Local"
    : es?.kind === "subsonic" ? "Subsonic"
    : resolvedSource?.name && resolvedSource.name !== "Library" ? resolvedSource.name
    : isLocal ? "Local" : "Remote";

  const openPanel = (rect: DOMRect) => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    setAnchor({ x: rect.left, y: rect.top - 8 });
    setOpen(true);
    // Fetch the engine's live decode facts on hover — by now decode has settled
    // (resolution/bitrate are ready). Null on the browser engine, which leaves
    // the lofty fallback.
    nativeEngine.getMediaInfo()
      .then(setMediaInfo)
      .catch((e) => console.error("Failed to load engine media info:", e));
  };
  const scheduleClose = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setOpen(false), 150);
  };

  return (
    <>
      <span
        className="now-source-icon"
        role="button"
        tabIndex={0}
        aria-label={`Playback source: ${sourceName}. Show details.`}
        onMouseEnter={(e) => openPanel(e.currentTarget.getBoundingClientRect())}
        onMouseLeave={scheduleClose}
        onFocus={(e) => openPanel(e.currentTarget.getBoundingClientRect())}
        onBlur={scheduleClose}
        onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
      >
        <SourceIcon isLocal={isLocal} />
      </span>
      {open && anchor && (
        <SourcePanel
          track={track}
          resolvedSource={resolvedSource}
          audioProps={audioProps}
          mediaInfo={mediaInfo}
          anchor={anchor}
          onKeepOpen={() => {
            if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

interface SourcePanelProps {
  track: QueueTrack;
  resolvedSource: ResolvedSource | null;
  audioProps: { sample_rate?: number; bit_depth?: number; channels?: number; bitrate?: number } | null;
  mediaInfo: EngineMediaInfo | null;
  anchor: { x: number; y: number };
  onKeepOpen: () => void;
  onClose: () => void;
}

function SourcePanel({ track, resolvedSource, audioProps, mediaInfo, anchor, onKeepOpen, onClose }: SourcePanelProps) {
  const path = track.path ?? "";
  const isSubsonic = path.startsWith("subsonic://");
  const isLocal = isLocalTrack(track);
  const resolverName = resolvedSource?.name;
  const sourceUrl = resolvedSource?.sourceUrl ?? null;

  let pluginProtocol: string | null = null;
  if (!isLocal && !isSubsonic && path.includes("://") && !path.startsWith("external://") && !path.startsWith("http://") && !path.startsWith("https://")) {
    pluginProtocol = path.substring(0, path.indexOf("://"));
  }

  // The resolver names itself (e.g. "YouTube", "TIDAL") — the host does not
  // special-case individual plugin ids here. "Library" is internal: its
  // effective source decides whether it reads "Local" or "Subsonic" (a Library
  // row can stream from a Subsonic server), else it falls through to a
  // path-derived label.
  const es = resolvedSource?.effectiveSource;
  const sourceLabel = es?.kind === "local" ? "Local"
    : es?.kind === "subsonic" ? "Subsonic"
    : resolverName && resolverName !== "Library" ? resolverName
    : pluginProtocol ? pluginProtocol.charAt(0).toUpperCase() + pluginProtocol.slice(1)
      : isSubsonic ? "Subsonic" : isLocal ? "Local" : (resolverName || "Unknown");

  const localPath = isLocal ? path.replace(/^file:\/\//, "") : null;
  // Library fallback: sourceUrl is the local file path
  const libraryFallbackPath = resolverName === "Library" && sourceUrl ? sourceUrl : null;
  const displayPath = localPath || libraryFallbackPath;

  // External link for the "open URL" action. Derived generically from the
  // resolver's reported sourceUrl — any plugin that returns an http(s) source
  // (YouTube, TIDAL, …) gets an "Open on <resolver>" button for free.
  let externalUrl: string | null = null;
  let externalLabel: string | null = null;
  if (sourceUrl && (sourceUrl.startsWith("http://") || sourceUrl.startsWith("https://"))) {
    externalUrl = sourceUrl;
    externalLabel = sourceLabel && sourceLabel !== "Unknown" ? `Open on ${sourceLabel}` : "Open link";
  } else if (isSubsonic && resolvedSource) {
    try {
      const u = new URL(resolvedSource.url);
      externalUrl = `${u.protocol}//${u.host}`;
      externalLabel = "Open server";
    } catch { /* ignore */ }
  }

  // Rows. Quality has two sources: lofty (audioProps, local files only,
  // richest — bit depth + channels) and the mpv engine's live decode
  // facts (mediaInfo — the ONLY source for remote/streamed audio + all
  // video). Video rows come only from the engine; audio rows prefer the
  // richer lofty props and fall back to the engine.
  const rows: Array<[string, React.ReactNode]> = [];
  const mi = mediaInfo;
  const hasVideo = !!mi && (!!mi.videoCodec || (!!mi.width && !!mi.height));
  if (hasVideo && mi) {
    const vparts: string[] = [];
    if (mi.videoCodec) vparts.push(mi.videoCodec.toUpperCase());
    if (mi.width && mi.height) {
      const sh = resolutionShorthand(mi.width, mi.height);
      vparts.push(sh ? `${mi.width}×${mi.height} (${sh})` : `${mi.width}×${mi.height}`);
    }
    if (mi.fps) vparts.push(`${Math.round(mi.fps)} fps`);
    if (vparts.length) rows.push(["video", vparts.join(" · ")]);
    if (mi.videoBitrate) rows.push(["video rate", `${Math.round(mi.videoBitrate / 1000)} kbps`]);
  }
  const hasLoftyAudio = !!(audioProps?.bitrate || audioProps?.sample_rate || audioProps?.channels);
  if (hasLoftyAudio) {
    // Local file: the full lofty picture (label "audio" when video shares the panel).
    if (track.format) rows.push([hasVideo ? "audio" : "format", track.format.toUpperCase()]);
    if (audioProps?.bitrate) rows.push([hasVideo ? "audio rate" : "bitrate", `${audioProps.bitrate} kbps`]);
    if (audioProps?.sample_rate) {
      const depth = audioProps.bit_depth ? ` · ${audioProps.bit_depth}-bit` : "";
      rows.push(["quality", `${(audioProps.sample_rate / 1000).toFixed(1)} kHz${depth}`]);
    }
    if (audioProps?.channels) {
      const label = audioProps.channels === 1 ? "Mono" : audioProps.channels === 2 ? "Stereo" : `${audioProps.channels} ch`;
      rows.push(["channels", label]);
    }
  } else if (mi && (mi.codec || mi.sampleRate || mi.bitrate)) {
    // Remote/streamed audio: the engine's live facts.
    const aparts: string[] = [];
    if (mi.codec) aparts.push(mi.codec.toUpperCase());
    if (mi.sampleRate) aparts.push(`${(mi.sampleRate / 1000).toFixed(1)} kHz`);
    if (aparts.length) rows.push([hasVideo ? "audio" : "format", aparts.join(" · ")]);
    if (mi.bitrate) rows.push([hasVideo ? "audio rate" : "bitrate", `${Math.round(mi.bitrate / 1000)} kbps`]);
  } else if (track.format) {
    // No decode facts yet — at least name the container format.
    rows.push(["format", track.format.toUpperCase()]);
  }
  if (displayPath) rows.push(["path", <span className="now-source-path" title={displayPath}>{displayPath}</span>]);
  if (sourceUrl && !displayPath && !sourceUrl.startsWith("file://")) {
    rows.push(["source", <span className="now-source-path" title={sourceUrl}>{sourceUrl}</span>]);
  } else if (!displayPath && !sourceUrl && !isLocal && resolvedSource) {
    try {
      const u = new URL(resolvedSource.url);
      rows.push(["host", u.hostname]);
    } catch { /* ignore */ }
  }

  return (
    <div
      className="ds-tooltip visible now-source-tooltip"
      style={{ left: anchor.x, top: anchor.y, transform: "translateY(-100%)" }}
      onMouseEnter={onKeepOpen}
      onMouseLeave={onClose}
    >
      <div className="ds-tooltip-title">{sourceLabel}</div>
      {rows.length > 0 && (
        <div className="ds-tooltip-rows">
          {rows.map(([k, v]) => (
            <div key={k} className="ds-tooltip-row">
              <span className="ds-tooltip-key">{k}</span>
              <span className="ds-tooltip-val">{v}</span>
            </div>
          ))}
        </div>
      )}
      {(displayPath || externalUrl) && (
        <div className="now-source-actions">
          {displayPath && (
            <button
              className="ds-btn ds-btn--ghost ds-btn--sm"
              onClick={() => {
                invoke("show_in_folder_path", { filePath: displayPath }).catch(e => console.error("Failed to show in folder:", e));
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              Open folder
            </button>
          )}
          {externalUrl && (
            <button
              className="ds-btn ds-btn--ghost ds-btn--sm"
              onClick={() => {
                openUrl(externalUrl!).catch(e => console.error("Failed to open URL:", e));
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              {externalLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
