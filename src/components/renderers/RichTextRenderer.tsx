import type { RendererProps } from "./index";
import type { RichTextData } from "../../types/informationTypes";
import { sanitizeHTML } from "../PluginViewRenderer";

export function RichTextRenderer({ data }: RendererProps) {
  const d = data as RichTextData;
  if (!d?.summary) return null;

  const html = d.summary;
  return (
    <div className="renderer-rich-text">
      <div dangerouslySetInnerHTML={{ __html: sanitizeHTML(html) }} />
    </div>
  );
}
