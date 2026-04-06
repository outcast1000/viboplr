import type { RendererProps } from "./index";
import type { AnnotatedTextData } from "../../types/informationTypes";
import { sanitizeHTML } from "../PluginViewRenderer";

export function AnnotatedTextRenderer({ data }: RendererProps) {
  const d = data as AnnotatedTextData;
  if (!d?.sections?.length && !d?.overview) return null;

  return (
    <div className="renderer-annotated-text">
      {d.overview && <p className="annotated-overview" dangerouslySetInnerHTML={{ __html: sanitizeHTML(d.overview) }} />}
      {d.sections?.map((s, i) => (
        <div key={i} className="annotated-section">
          {s.heading && <h4>{s.heading}</h4>}
          <p dangerouslySetInnerHTML={{ __html: sanitizeHTML(s.text) }} />
        </div>
      ))}
    </div>
  );
}
