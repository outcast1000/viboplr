import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";
import { useInformationTypes } from "../hooks/useInformationTypes";
import { TitleLineRenderer } from "./renderers/TitleLineRenderer";

interface TitleLineInfoProps {
  entity: InfoEntity | null;
  invokeInfoFetch: (
    pluginId: string,
    infoTypeId: string,
    entity: InfoEntity,
  ) => Promise<InfoFetchResult>;
}

export function TitleLineInfo({ entity, invokeInfoFetch }: TitleLineInfoProps) {
  const { sections } = useInformationTypes({ entity, invokeInfoFetch });

  const titleLines = sections.filter(
    (s) => s.displayKind === "title_line" && s.state.kind === "loaded" && s.state.data,
  );

  if (!titleLines.length) return null;

  // Several providers can each contribute a line (Last.fm listeners, Spotify
  // monthly listeners); join them with the same " · " the renderer puts
  // between items, or they run together into one unreadable string.
  return (
    <>
      {titleLines.map((s, i) => (
        <span key={s.typeId}>
          {i > 0 && " · "}
          <TitleLineRenderer data={s.state.kind === "loaded" ? s.state.data : null} />
        </span>
      ))}
    </>
  );
}
