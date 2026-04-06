import type { RendererProps } from "./index";
import type { LyricsData } from "../../types/informationTypes";

export function LyricsRenderer({ data }: RendererProps) {
  const d = data as LyricsData;
  if (!d?.text) return null;

  return (
    <div className="renderer-lyrics">
      <pre className="lyrics-plain">{d.text}</pre>
    </div>
  );
}
