import { useId } from "react";
import type { ProviderSuggestion } from "../utils/providerSuggestions";
import "./ProviderSuggestionList.css";

interface Props {
  /** One sentence: what wasn't found and that these could find it. */
  heading: string;
  plugins: ProviderSuggestion[];
  /** Opens that plugin's page in Extensions; installing / switching it on
   *  stays the user's step there. */
  onShowPlugin: (pluginId: string) => void;
  /** What to do after (e.g. "…then choose Try again"). */
  note?: string;
}

/**
 * "These plugins could find it" — the block the playback failure dialog and
 * the Retrieve modal show after a provider chain came back empty. Rows come
 * from `utils/providerSuggestions.ts`; nothing here installs anything.
 */
export function ProviderSuggestionList({ heading, plugins, onShowPlugin, note }: Props) {
  // Per instance: two lists can be mounted at once (failure dialog + Retrieve).
  const titleId = useId();
  return (
    <section className="provider-suggest" aria-labelledby={titleId}>
      <h3 className="provider-suggest-title" id={titleId}>{heading}</h3>
      <ul className="provider-suggest-list">
        {plugins.map((p) => (
          <li key={p.id} className="provider-suggest-item">
            <div className="provider-suggest-text">
              <span className="provider-suggest-name">
                {p.name}
                {p.action === "enable" && <span className="provider-suggest-tag">Installed, off</span>}
                {p.experimental && <span className="provider-suggest-tag">Experimental</span>}
              </span>
              {p.description && <span className="provider-suggest-desc">{p.description}</span>}
            </div>
            <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={() => onShowPlugin(p.id)}>
              {p.action === "enable" ? "Turn on…" : "View plugin…"}
            </button>
          </li>
        ))}
      </ul>
      {note && <p className="provider-suggest-note">{note}</p>}
    </section>
  );
}
