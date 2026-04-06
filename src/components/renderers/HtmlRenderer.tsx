import type { RendererProps } from "./index";
import type { HtmlData } from "../../types/informationTypes";
import { sanitizeHTML } from "../PluginViewRenderer";

export function HtmlRenderer({ data }: RendererProps) {
  const d = data as HtmlData;
  if (!d?.content) return null;
  return (
    <div className="renderer-html" dangerouslySetInnerHTML={{ __html: sanitizeHTML(d.content) }} />
  );
}
