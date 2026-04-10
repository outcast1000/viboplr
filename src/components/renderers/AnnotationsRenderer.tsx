import { useState, useMemo } from "react";
import type { RendererProps } from "./index";
import type { AnnotationsData } from "../../types/informationTypes";

/** Build a map from normalized lyrics line → annotation explanation(s). */
function buildAnnotationMap(
  lyrics: string,
  annotations: Array<{ fragment: string; explanation: string }>,
): Map<number, Array<{ fragment: string; explanation: string }>> {
  const lines = lyrics.split("\n");
  const lineMap = new Map<number, Array<{ fragment: string; explanation: string }>>();

  for (const ann of annotations) {
    const fragLower = ann.fragment.toLowerCase().trim();
    if (!fragLower) continue;
    // Find the best matching line — check substring containment
    let bestIdx = -1;
    let bestLen = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineLower = lines[i].toLowerCase().trim();
      if (!lineLower) continue;
      if (lineLower.includes(fragLower) || fragLower.includes(lineLower)) {
        const matchLen = Math.min(lineLower.length, fragLower.length);
        if (matchLen > bestLen) {
          bestLen = matchLen;
          bestIdx = i;
        }
      }
    }
    if (bestIdx >= 0) {
      const existing = lineMap.get(bestIdx) || [];
      existing.push(ann);
      lineMap.set(bestIdx, existing);
    }
  }

  return lineMap;
}

export function AnnotationsRenderer({ data }: RendererProps) {
  const d = data as AnnotationsData;
  const [expandedLines, setExpandedLines] = useState<Set<number>>(new Set());

  const lyrics = d?.lyrics;
  const lyricsLines = useMemo(() => lyrics?.split("\n") ?? [], [lyrics]);
  const annotationMap = useMemo(
    () => (lyrics && d?.annotations?.length ? buildAnnotationMap(lyrics, d.annotations) : new Map()),
    [lyrics, d?.annotations],
  );

  if (!d?.annotations?.length && !d?.overview && !lyrics) return null;

  const toggleLine = (idx: number) => {
    setExpandedLines(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  // If we have lyrics, show them with inline annotations
  if (lyrics && lyricsLines.length > 0) {
    return (
      <div className="renderer-annotations">
        {d.overview && <p className="annotations-overview">{d.overview}</p>}
        <div className="annotations-lyrics-body">
          {lyricsLines.map((line, i) => {
            const anns = annotationMap.get(i);
            const hasAnnotation = anns && anns.length > 0;
            const isExpanded = expandedLines.has(i);
            const isEmpty = !line.trim();

            if (isEmpty) {
              return <div key={i} className="annotations-lyrics-blank" />;
            }

            return (
              <div key={i} className="annotations-lyrics-line-group">
                <div
                  className={`annotations-lyrics-line${hasAnnotation ? " annotated" : ""}${isExpanded ? " expanded" : ""}`}
                  onClick={hasAnnotation ? () => toggleLine(i) : undefined}
                >
                  {line}
                </div>
                {hasAnnotation && isExpanded && anns!.map((ann: { fragment: string; explanation: string }, j: number) => (
                  <div key={j} className="annotations-inline-explanation">
                    {ann.explanation}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Fallback: no lyrics, show classic annotations list
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
