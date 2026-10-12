import { useEffect, useState } from "react";
import { HelpLink } from "./HelpLink";
import { ToggleSwitch } from "./ToggleSwitch";
import {
  describeScrobblerStatus,
  scrobbleMediaFor,
  scrobblerStatusFor,
  withScrobbleMedia,
  type ScrobbleDefaults,
  type ScrobblerEntry,
  type ScrobblerStatuses,
  type ScrobbleSettings,
} from "../utils/scrobblers";
import { relativeTime } from "../utils/assistantActivity";
import type { DiagnosticContext } from "../utils/diagnosticReport";

/** Settings → Playback → Scrobbling: every scrobbler (local history + each plugin
 *  subscribed to `track:scrobbled`) with its own Audio / Video switches and
 *  what happened to its last play. These switches are the only on/off for
 *  scrobbling; sign-in stays in the plugin, and a signed-out plugin says so
 *  in its status line. */
export function ScrobblingSettings({
  scrobblers,
  settings,
  onChange,
  statuses,
  defaults,
  onReportProblem,
}: {
  scrobblers: ScrobblerEntry[];
  settings: ScrobbleSettings;
  /** Takes an updater, so two changes in one batch both land. */
  onChange: (update: (prev: ScrobbleSettings) => ScrobbleSettings) => void;
  statuses: ScrobblerStatuses;
  defaults: ScrobbleDefaults;
  onReportProblem: (report: { title: string; context: DiagnosticContext }) => void;
}) {
  // "2 min ago" has to move while the page is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const ago = (thenMs: number) => relativeTime(thenMs, now);

  return (
    <div className="settings-group" id="scrobbling">
      <div className="settings-group-title">Scrobbling<HelpLink anchor="scrobbling" topic="scrobbling" /></div>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-description">
              A play counts once you've heard half the track or 4 minutes, whichever comes first; tracks under 30 seconds never count. Choose which scrobblers record audio and which record video.
            </span>
          </div>
        </div>
        {scrobblers.map((s) => {
          const media = scrobbleMediaFor(settings, s.id, defaults);
          const status = scrobblerStatusFor(statuses, s.id);
          const line = describeScrobblerStatus(status, ago);
          return (
            <div className="settings-row" key={s.id}>
              <div className="settings-row-info">
                <span className="settings-label">{s.name}{s.builtin ? "" : " (plugin)"}</span>
                {s.description && <span className="settings-description">{s.description}</span>}
                <span className={`scrobbler-status scrobbler-status--${line.tone}`}>
                  <span className="scrobbler-status-dot" aria-hidden="true" />
                  <span className="scrobbler-status-text">{line.text}</span>
                  {status?.status === "failed" && (
                    <button
                      type="button"
                      className="scrobbler-status-report"
                      onClick={() => onReportProblem({
                        title: `Scrobbling failed: ${s.name}`,
                        context: {
                          title: "Scrobbling",
                          lines: [
                            `Scrobbler: ${s.name} (${s.id})`,
                            `Play: ${status.title ?? "unknown"}${status.artist ? ` – ${status.artist}` : ""}`,
                            `Error: ${status.message ?? "unknown"}`,
                            `When: ${new Date(status.at).toISOString()}`,
                          ],
                        },
                      })}
                    >
                      Report a problem
                    </button>
                  )}
                </span>
              </div>
              <div className="scrobbler-media">
                <label className="scrobbler-media-toggle">
                  <span>Audio</span>
                  <ToggleSwitch
                    label={`${s.name}: record audio`}
                    checked={media.audio}
                    onChange={(audio) => onChange((prev) => withScrobbleMedia(prev, s.id, { audio }, defaults))}
                  />
                </label>
                <label className="scrobbler-media-toggle">
                  <span>Video</span>
                  <ToggleSwitch
                    label={`${s.name}: record video`}
                    checked={media.video}
                    onChange={(video) => onChange((prev) => withScrobbleMedia(prev, s.id, { video }, defaults))}
                  />
                </label>
              </div>
            </div>
          );
        })}
        {scrobblers.length === 1 && (
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-description">
                Plugins that scrobble — Last.fm, Vibo Community and others — appear here once they're enabled in Extensions.
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
