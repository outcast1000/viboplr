// Fixed, host-defined "max preferred format" ladder for full-mode mixtape export.
//
// These are HINT strings passed to the download resolve chain as `options.format`
// — NOT a transcoding instruction. Each download provider interprets the hint and
// falls back to its best native option when it can't honor it ("provider decides").
// The packed file's real extension is sniffed from the resolved URL by the backend.
// Rendered highest-quality-first.
export interface MixtapeFormatOption {
  value: string;
  label: string;
}

export const MIXTAPE_FORMAT_LADDER: MixtapeFormatOption[] = [
  { value: "flac-hires", label: "FLAC hi-res" },
  { value: "flac", label: "FLAC (lossless)" },
  { value: "aac", label: "AAC / M4A" },
  { value: "mp3", label: "MP3" },
];

// Matches the backend `.unwrap_or("flac")` default so untouched exports are unchanged.
export const MIXTAPE_FORMAT_DEFAULT = "flac";
