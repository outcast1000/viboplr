import { openUrl } from "@tauri-apps/plugin-opener";
import { LINKS } from "../constants/links";
import "./HelpLink.css";

interface HelpLinkProps {
  /** Section id on the site's help page. Anchors there are add-only — never rename one. */
  anchor: string;
  /** Topic name for the accessible label, e.g. "exclusive audio access". */
  topic: string;
}

/** Small "?" affordance that opens the matching topic on the viboplr.com help page. */
export function HelpLink({ anchor, topic }: HelpLinkProps) {
  return (
    <button
      className="help-link"
      aria-label={`Learn more about ${topic}`}
      title="Learn more"
      onClick={(e) => {
        e.stopPropagation();
        openUrl(`${LINKS.helpPage}#${anchor}`).catch(console.error);
      }}
    >
      ?
    </button>
  );
}
