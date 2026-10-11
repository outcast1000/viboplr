import { HelpLink } from "./HelpLink";
import { ToggleSwitch } from "./ToggleSwitch";
import {
  scrobbleMediaFor,
  withScrobbleMedia,
  type ScrobblerEntry,
  type ScrobbleSettings,
} from "../utils/scrobblers";

/** Settings → Scrobbling: every scrobbler (local history + each plugin
 *  subscribed to `track:scrobbled`) with its own Audio / Video switches.
 *  Whether a plugin scrobbler is signed in or switched on stays the plugin's
 *  own setting; this only filters which plays reach it. */
export function ScrobblingSettings({
  scrobblers,
  settings,
  onChange,
}: {
  scrobblers: ScrobblerEntry[];
  settings: ScrobbleSettings;
  /** Takes an updater, so two changes in one batch both land. */
  onChange: (update: (prev: ScrobbleSettings) => ScrobbleSettings) => void;
}) {
  return (
    <div className="settings-group" id="scrobbling">
      <div className="settings-group-title">Scrobblers<HelpLink anchor="scrobbling" topic="scrobbling" /></div>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-description">
              A play counts once you've heard half the track or 4 minutes, whichever comes first; tracks under 30 seconds never count. Choose which scrobblers record audio and which record video.
            </span>
          </div>
        </div>
        {scrobblers.map((s) => {
          const media = scrobbleMediaFor(settings, s.id);
          return (
            <div className="settings-row" key={s.id}>
              <div className="settings-row-info">
                <span className="settings-label">{s.name}{s.builtin ? "" : " (plugin)"}</span>
                {s.description && <span className="settings-description">{s.description}</span>}
              </div>
              <div className="scrobbler-media">
                <label className="scrobbler-media-toggle">
                  <span>Audio</span>
                  <ToggleSwitch
                    label={`${s.name}: record audio`}
                    checked={media.audio}
                    onChange={(audio) => onChange((prev) => withScrobbleMedia(prev, s.id, { audio }))}
                  />
                </label>
                <label className="scrobbler-media-toggle">
                  <span>Video</span>
                  <ToggleSwitch
                    label={`${s.name}: record video`}
                    checked={media.video}
                    onChange={(video) => onChange((prev) => withScrobbleMedia(prev, s.id, { video }))}
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
