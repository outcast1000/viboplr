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
  setArtistImages,
  setAlbumImages,
  setTagImages,
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
  setArtistImages: React.Dispatch<React.SetStateAction<Record<number, string | null>>>;
  setAlbumImages: React.Dispatch<React.SetStateAction<Record<number, string | null>>>;
  setTagImages: React.Dispatch<React.SetStateAction<Record<number, string | null>>>;
  addLog: (text: string) => void;
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

      const isArtistDetail = view === "artists" && selectedArtist !== null;
      const isAlbumDetail = view === "all" && selectedAlbum !== null && !searchQuery.trim();
      const isTagDetail = view === "all" && selectedTag !== null && !searchQuery.trim();

      if (!isArtistDetail && !isAlbumDetail && !isTagDetail) return;

      e.preventDefault();

      const blob = imageItem.getAsFile();
      if (!blob) return;

      try {
        const buffer = await blob.arrayBuffer();
        const imageData = Array.from(new Uint8Array(buffer));

        if (isArtistDetail) {
          const path = await invoke<string>("paste_artist_image", {
            artistId: selectedArtist,
            imageData,
          });
          setArtistImages((prev) => ({ ...prev, [selectedArtist!]: path }));
          addLog("Artist image set from clipboard: " + (artists.find(a => a.id === selectedArtist)?.name ?? "unknown"));
        } else if (isAlbumDetail) {
          const path = await invoke<string>("paste_album_image", {
            albumId: selectedAlbum,
            imageData,
          });
          setAlbumImages((prev) => ({ ...prev, [selectedAlbum!]: path }));
          addLog("Album image set from clipboard: " + (albums.find(a => a.id === selectedAlbum)?.title ?? "unknown"));
        } else if (isTagDetail) {
          const path = await invoke<string>("paste_tag_image", {
            tagId: selectedTag,
            imageData,
          });
          setTagImages((prev) => ({ ...prev, [selectedTag!]: path }));
          addLog("Tag image set from clipboard: " + (tags.find(t => t.id === selectedTag)?.name ?? "unknown"));
        }
      } catch (err) {
        addLog(`Failed to paste image: ${err}`);
      }
    };

    document.addEventListener("paste", handler);
    return () => document.removeEventListener("paste", handler);
  }, [view, selectedArtist, selectedAlbum, selectedTag, searchQuery, artists, albums, tags, setArtistImages, setAlbumImages, setTagImages, addLog]);
}
