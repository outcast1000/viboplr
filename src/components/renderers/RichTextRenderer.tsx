import type { RendererProps } from "./index";
import type { RichTextData } from "../../types/informationTypes";
import { useState } from "react";
import { sanitizeHTML } from "../PluginViewRenderer";

export function RichTextRenderer({ data }: RendererProps) {
  const d = data as RichTextData;
  const [expanded, setExpanded] = useState(false);
  if (!d?.summary) return null;

  const html = expanded && d.full ? d.full : d.summary;
  return (
    <div className="renderer-rich-text">
      <div dangerouslySetInnerHTML={{ __html: sanitizeHTML(html) }} />
      {d.full && (
        <button className="text-toggle" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Read more"}
        </button>
      )}
    </div>
  );
}
