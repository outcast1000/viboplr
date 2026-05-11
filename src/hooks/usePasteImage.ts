import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { View, Artist, Album, Tag } from "../types";

export function usePasteImage({
  view,
  selectedArtist,
  selectedAlbum,
  selectedTag,
  searchQuery,
  artists,
  albums,
  tags,
  invalidateArtistImage,
  invalidateAlbumImage,
  invalidateTagImage,
  addLog,
}: {
  view: View;
  selectedArtist: number | null;
  selectedAlbum: number | null;
  selectedTag: number | null;
  searchQuery: string;
  artists: Artist[];
  albums: Album[];
  tags: Tag[];
  invalidateArtistImage: (name: string) => void;
  invalidateAlbumImage: (name: string, artistName?: string) => void;
  invalidateTagImage: (name: string) => void;
  addLog: (text: string, module?: string) => void;
}) {
  useEffect(() => {
    const handler = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      let imageItem: DataTransferItem | null = null;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith("image/")) {
          imageItem = items[i];
          break;
        }
      }
      if (!imageItem) return;

      const isAlbumDetail = (view === "albums" || view === "artists") && selectedAlbum !== null && !searchQuery.trim();
      const isArtistDetail = view === "artists" && selectedArtist !== null && !isAlbumDetail;
      const isTagDetail = view === "tags" && selectedTag !== null && !searchQuery.trim();

      if (!isArtistDetail && !isAlbumDetail && !isTagDetail) return;

      e.preventDefault();

      const blob = imageItem.getAsFile();
      if (!blob) return;

      try {
        const buffer = await blob.arrayBuffer();
        const imageData = Array.from(new Uint8Array(buffer));

        let kind: "artist" | "album" | "tag";
        let entityName: string;
        let artistName: string | null = null;

        if (isArtistDetail) {
          kind = "artist";
          const artist = artists.find(a => a.id === selectedArtist);
          if (!artist) return;
          entityName = artist.name;
        } else if (isAlbumDetail) {
          kind = "album";
          const album = albums.find(a => a.id === selectedAlbum);
          if (!album) return;
          entityName = album.title;
          artistName = album.artist_name ?? null;
        } else {
          kind = "tag";
          const tag = tags.find(t => t.id === selectedTag);
          if (!tag) return;
          entityName = tag.name;
        }

        await invoke<string>("paste_entity_image", {
          kind,
          name: entityName,
          artistName,
          imageData,
        });

        if (kind === "artist") {
          invalidateArtistImage(entityName);
          addLog(`Artist image set from clipboard: ${entityName}`, "images");
        } else if (kind === "album") {
          invalidateAlbumImage(entityName, artistName ?? undefined);
          addLog(`Album image set from clipboard: ${entityName}`, "images");
        } else {
          invalidateTagImage(entityName);
          addLog(`Tag image set from clipboard: ${entityName}`, "images");
        }
      } catch (err) {
        console.error("Failed to paste image:", err);
        addLog(`Failed to paste image: ${err}`, "images");
      }
    };

    document.addEventListener("paste", handler);
    return () => document.removeEventListener("paste", handler);
  }, [view, selectedArtist, selectedAlbum, selectedTag, searchQuery, artists, albums, tags, invalidateArtistImage, invalidateAlbumImage, invalidateTagImage, addLog]);
}
