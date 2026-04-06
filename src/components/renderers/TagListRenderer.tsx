import type { RendererProps } from "./index";
import type { TagListData } from "../../types/informationTypes";

export function TagListRenderer({ data, onAction }: RendererProps) {
  const d = data as TagListData;
  if (!d?.tags?.length) return null;

  return (
    <div className="renderer-tag-list">
      {d.tags.map((tag, i) => (
        <span
          key={i}
          className={`tag-pill${d.suggestable ? " suggestable" : ""}`}
          onClick={() => d.suggestable && onAction?.("apply_tag", { name: tag.name })}
        >
          {tag.name}
        </span>
      ))}
    </div>
  );
}
