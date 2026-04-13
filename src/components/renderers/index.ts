import type { ComponentType, MouseEvent } from "react";
import "./renderers.css";
import { RichTextRenderer } from "./RichTextRenderer";
import { HtmlRenderer } from "./HtmlRenderer";
import { EntityListRenderer } from "./EntityListRenderer";
import { EntityCardsRenderer } from "./EntityCardsRenderer";
import { StatGridRenderer } from "./StatGridRenderer";
import { TagListRenderer } from "./TagListRenderer";
import { RankedListRenderer } from "./RankedListRenderer";
import { AnnotatedTextRenderer } from "./AnnotatedTextRenderer";
import { AnnotationsRenderer } from "./AnnotationsRenderer";
import { KeyValueRenderer } from "./KeyValueRenderer";
import { ImageGalleryRenderer } from "./ImageGalleryRenderer";
import { LyricsRenderer } from "./LyricsRenderer";
import { TitleLineRenderer } from "./TitleLineRenderer";

export interface RendererProps {
  data: unknown;
  onEntityClick?: (kind: string, id?: number, name?: string) => void;
  onAction?: (actionId: string, payload?: unknown) => void;
  resolveEntity?: (kind: string, name: string) => { id?: number; imageSrc?: string } | undefined;
  context?: { positionSecs?: number };
  onTrackContextMenu?: (e: MouseEvent, trackInfo: { trackId?: number; title: string; artistName: string | null }) => void;
  onEntityContextMenu?: (e: MouseEvent, info: { kind: "track" | "artist" | "album"; id?: number; name: string; artistName?: string | null }) => void;
}

export const renderers: Record<string, ComponentType<RendererProps>> = {
  rich_text: RichTextRenderer,
  html: HtmlRenderer,
  entity_list: EntityListRenderer,
  entity_cards: EntityCardsRenderer,
  stat_grid: StatGridRenderer,
  lyrics: LyricsRenderer,
  tag_list: TagListRenderer,
  ranked_list: RankedListRenderer,
  annotated_text: AnnotatedTextRenderer,
  annotations: AnnotationsRenderer,
  key_value: KeyValueRenderer,
  image_gallery: ImageGalleryRenderer,
  title_line: TitleLineRenderer,
};
