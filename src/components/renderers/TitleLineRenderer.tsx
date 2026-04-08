import type { RendererProps } from "./index";
import type { TitleLineData } from "../../types/informationTypes";

export function TitleLineRenderer({ data }: RendererProps) {
  const d = data as TitleLineData;
  if (!d?.items?.length) return null;

  return (
    <span className="renderer-title-line">
      {d.items.map((item, i) => (
        <span key={i}>
          {i > 0 && " \u00B7 "}
          {typeof item.value === "number" ? item.value.toLocaleString() : item.value} {item.label}
        </span>
      ))}
    </span>
  );
}
