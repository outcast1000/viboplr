// Destination-path helpers for download placement (split out of DownloadModal.tsx).

export const PATH_PATTERNS = [
  { value: "[artist]/[album]/[track_number] - [title]", label: "Artist / Album / 01 - Title" },
  { value: "[artist] - [album]/[track_number] - [title]", label: "Artist - Album / 01 - Title" },
  { value: "[artist]/[album]/[artist] - [track_number] - [title]", label: "Artist / Album / Artist - 01 - Title" },
  { value: "[artist] - [album] - [track_number] - [title]", label: "Artist - Album - 01 - Title (flat)" },
];

export function previewPattern(pattern: string, artist: string, album: string, title: string, ext: string): string {
  return pattern
    .replace(/\[artist\]/g, artist || "Artist")
    .replace(/\[album\]/g, album || "Album")
    .replace(/\[track_number\]/g, "01")
    .replace(/\[title\]/g, title || "Track Name")
    + "." + ext;
}

export function buildDestPath(
  collectionPath: string,
  pattern: string,
  title: string,
  artist: string,
  album: string,
  trackNumber: number | null,
  ext: string
): string {
  const sanitize = (s: string) => s.replace(/[/\\:*?"<>|]/g, "_").trim() || "Unknown";
  const num = trackNumber ? String(trackNumber).padStart(2, "0") : "";
  const expanded = pattern
    .replace(/\[artist\]/g, sanitize(artist))
    .replace(/\[album\]/g, sanitize(album))
    .replace(/\[track_number\]/g, num)
    .replace(/\[title\]/g, sanitize(title));
  return collectionPath + "/" + expanded + "." + ext;
}
