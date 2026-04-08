import type { RendererProps } from "./index";
import type { AnnotationsData } from "../../types/informationTypes";

export function AnnotationsRenderer({ data }: RendererProps) {
  const d = data as AnnotationsData;
  if (!d?.annotations?.length && !d?.overview) return null;

  return (
    <div className="renderer-annotations">
      {d.overview && <p className="annotations-overview">{d.overview}</p>}
      {d.annotations?.length > 0 && (
        <div className="annotations-list">
          {d.annotations.map((ann, i) => (
            <div key={i} className="annotations-item">
              <div className="annotations-fragment">{ann.fragment}</div>
              <div className="annotations-explanation">{ann.explanation}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
