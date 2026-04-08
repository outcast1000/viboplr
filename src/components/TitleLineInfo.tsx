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

  return (
    <>
      {titleLines.map((s) => (
        <TitleLineRenderer key={s.typeId} data={s.state.kind === "loaded" ? s.state.data : null} />
      ))}
    </>
  );
}
