import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { View } from "../types";

export function usePasteImage({
  view,
  selectedArtist,
  selectedAlbum,
  searchQuery,
  setArtistImages,
  setAlbumImages,
  addNotification,
}: {
  view: View;
  selectedArtist: number | null;
  selectedAlbum: number | null;
  searchQuery: string;
  setArtistImages: React.Dispatch<React.SetStateAction<Record<number, string | null>>>;
  setAlbumImages: React.Dispatch<React.SetStateAction<Record<number, string | null>>>;
  addNotification: (text: string) => void;
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

      if (!isArtistDetail && !isAlbumDetail) return;

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
          addNotification("Artist image set from clipboard");
        } else if (isAlbumDetail) {
          const path = await invoke<string>("paste_album_image", {
            albumId: selectedAlbum,
            imageData,
          });
          setAlbumImages((prev) => ({ ...prev, [selectedAlbum!]: path }));
          addNotification("Album image set from clipboard");
        }
      } catch (err) {
        addNotification(`Failed to paste image: ${err}`);
      }
    };

    document.addEventListener("paste", handler);
    return () => document.removeEventListener("paste", handler);
  }, [view, selectedArtist, selectedAlbum, searchQuery, setArtistImages, setAlbumImages, addNotification]);
}
