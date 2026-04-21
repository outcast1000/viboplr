import { describe, it, expect } from "vitest";

const DEFAULT_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "in", "to", "for", "by", "with",
  "from", "at", "on", "vol", "volume", "disc", "cd", "various", "artists",
  "various artists", "unknown", "misc", "other", "music", "feat", "ft", "featuring",
]);

function normalize(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

function stripTrackNumber(filename: string): string {
  return filename.replace(/^\d{1,3}[\s.\-_]*(?:\d{1,3}[\s.\-_]*)?(?:\-\s*)?/, "").trim();
}

function splitSegmentOnDelimiters(segment: string): string[] {
  const parts = segment.split(/\s-\s|_/).map((s) => s.trim()).filter(Boolean);
  const result: string[] = [];
  for (const part of parts) {
    const cleaned = part.replace(/[(\[][^\])]*[)\]]/g, "").trim();
    const brackets = [...part.matchAll(/[(\[]([^\])]+)[)\]]/g)].map((m) => m[1].trim());
    if (cleaned) result.push(cleaned);
    result.push(...brackets.filter(Boolean));
  }
  return result;
}

function generateNgrams(words: string[], maxN: number = 3): string[] {
  const ngrams: string[] = [];
  for (let n = 1; n <= maxN; n++) {
    for (let i = 0; i <= words.length - n; i++) {
      ngrams.push(words.slice(i, i + n).join(" "));
    }
  }
  return ngrams;
}

function tokenizePath(
  path: string,
  collectionRoot: string,
  stopwords: Set<string> = DEFAULT_STOPWORDS,
): string[] {
  let cleaned = path.replace(/^file:\/\//, "");
  if (cleaned.startsWith(collectionRoot)) {
    cleaned = cleaned.slice(collectionRoot.length);
  }
  cleaned = cleaned.replace(/^\//, "");
  const segments = cleaned.split(/[/\\]/).filter(Boolean);
  if (segments.length === 0) return [];
  const lastIdx = segments.length - 1;
  segments[lastIdx] = stripTrackNumber(stripExtension(segments[lastIdx]));
  if (!segments[lastIdx]) segments.pop();

  const allNgrams: string[] = [];
  for (const segment of segments) {
    const subSegments = splitSegmentOnDelimiters(segment);
    for (const sub of subSegments) {
      const words = sub.split(/\s+/).filter(Boolean);
      const ngrams = generateNgrams(words);
      for (const ng of ngrams) {
        const norm = normalize(ng);
        const wordCount = norm.split(/\s+/).length;
        if (norm.length <= 1) continue;
        if (/^\d+$/.test(norm)) continue;
        if (wordCount === 1 && stopwords.has(norm)) continue;
        allNgrams.push(norm);
      }
    }
  }
  return allNgrams;
}

function tokenizeMetadata(
  title: string,
  artistName: string | null,
  albumTitle: string | null,
  stopwords: Set<string> = DEFAULT_STOPWORDS,
): string[] {
  const parts = [title, artistName, albumTitle].filter(Boolean) as string[];
  const allNgrams: string[] = [];
  for (const part of parts) {
    const subSegments = splitSegmentOnDelimiters(part);
    for (const sub of subSegments) {
      const words = sub.split(/\s+/).filter(Boolean);
      const ngrams = generateNgrams(words);
      for (const ng of ngrams) {
        const norm = normalize(ng);
        const wordCount = norm.split(/\s+/).length;
        if (norm.length <= 1) continue;
        if (/^\d+$/.test(norm)) continue;
        if (wordCount === 1 && stopwords.has(norm)) continue;
        allNgrams.push(norm);
      }
    }
  }
  return allNgrams;
}

function countFrequencies(allNgrams: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const ng of allNgrams) {
    freq.set(ng, (freq.get(ng) ?? 0) + 1);
  }
  return freq;
}

function matchApprovedTags(ngrams: string[], approvedTags: string[]): string[] {
  const normalizedApproved = new Set(approvedTags.map(normalize));
  const matched = new Set<string>();
  for (const ng of ngrams) {
    if (normalizedApproved.has(ng)) {
      const original = approvedTags.find((t) => normalize(t) === ng);
      if (original) matched.add(original);
    }
  }
  return [...matched];
}

describe("normalize", () => {
  it("lowercases and strips diacritics", () => {
    expect(normalize("Éléctronique")).toBe("electronique");
    expect(normalize("Björk")).toBe("bjork");
    expect(normalize("DEEP HOUSE")).toBe("deep house");
  });

  it("trims whitespace", () => {
    expect(normalize("  Rock  ")).toBe("rock");
  });
});

describe("stripExtension", () => {
  it("strips common audio extensions", () => {
    expect(stripExtension("track.flac")).toBe("track");
    expect(stripExtension("track.mp3")).toBe("track");
    expect(stripExtension("song.name.wav")).toBe("song.name");
  });
});

describe("stripTrackNumber", () => {
  it("strips leading track numbers", () => {
    expect(stripTrackNumber("01 Track Name")).toBe("Track Name");
    expect(stripTrackNumber("01. Track Name")).toBe("Track Name");
    expect(stripTrackNumber("01 - Track Name")).toBe("Track Name");
    expect(stripTrackNumber("1-01 Track Name")).toBe("Track Name");
    expect(stripTrackNumber("12 Song")).toBe("Song");
  });

  it("does not strip non-leading numbers", () => {
    expect(stripTrackNumber("Track 42")).toBe("Track 42");
  });
});

describe("splitSegmentOnDelimiters", () => {
  it("splits on ' - ' delimiter", () => {
    expect(splitSegmentOnDelimiters("DJ Shadow - Endtroducing")).toEqual([
      "DJ Shadow",
      "Endtroducing",
    ]);
  });

  it("splits on '_' delimiter", () => {
    expect(splitSegmentOnDelimiters("Electronic_Ambient")).toEqual([
      "Electronic",
      "Ambient",
    ]);
  });

  it("extracts parenthetical content", () => {
    expect(splitSegmentOnDelimiters("Track Name (Remix)")).toEqual([
      "Track Name",
      "Remix",
    ]);
  });

  it("extracts bracket content", () => {
    expect(splitSegmentOnDelimiters("Track Name [Live]")).toEqual([
      "Track Name",
      "Live",
    ]);
  });
});

describe("generateNgrams", () => {
  it("generates 1/2/3-grams", () => {
    const words = ["Deep", "House", "Music"];
    const result = generateNgrams(words);
    expect(result).toEqual([
      "Deep", "House", "Music",
      "Deep House", "House Music",
      "Deep House Music",
    ]);
  });

  it("returns single word for single-word input", () => {
    expect(generateNgrams(["Electronic"])).toEqual(["Electronic"]);
  });

  it("returns empty for empty input", () => {
    expect(generateNgrams([])).toEqual([]);
  });
});

describe("tokenizePath", () => {
  it("tokenizes a typical music path", () => {
    const ngrams = tokenizePath(
      "file:///Music/Electronic/Deep House/track.flac",
      "/Music",
    );
    expect(ngrams).toContain("electronic");
    expect(ngrams).toContain("deep");
    expect(ngrams).toContain("house");
    expect(ngrams).toContain("deep house");
    expect(ngrams).toContain("track");
  });

  it("strips collection root prefix", () => {
    const ngrams = tokenizePath(
      "file:///Users/alex/Music/Rock/song.mp3",
      "/Users/alex/Music",
    );
    expect(ngrams).toContain("rock");
    expect(ngrams).toContain("song");
    expect(ngrams).not.toContain("users");
    expect(ngrams).not.toContain("alex");
  });

  it("strips file extension", () => {
    const ngrams = tokenizePath("file:///Music/song.flac", "/Music");
    expect(ngrams).not.toContain("flac");
    expect(ngrams).toContain("song");
  });

  it("strips track numbers from filename", () => {
    const ngrams = tokenizePath("file:///Music/01 Song Title.mp3", "/Music");
    expect(ngrams).toContain("song");
    expect(ngrams).toContain("title");
    expect(ngrams).not.toContain("01");
  });

  it("filters out stopwords as 1-grams but keeps them in multi-grams", () => {
    const ngrams = tokenizePath("file:///Music/Out Of Time/song.mp3", "/Music");
    expect(ngrams).not.toContain("of");
    expect(ngrams).toContain("out of time");
  });

  it("filters out pure numbers", () => {
    const ngrams = tokenizePath("file:///Music/2024/song.mp3", "/Music");
    expect(ngrams).not.toContain("2024");
  });

  it("handles diacritics in normalization", () => {
    const ngrams = tokenizePath("file:///Music/Café Del Mar/track.flac", "/Music");
    expect(ngrams).toContain("cafe");
    expect(ngrams).toContain("mar");
  });

  it("handles artist - album folder format", () => {
    const ngrams = tokenizePath(
      "file:///Music/Rock/Pink Floyd - The Wall/track.mp3",
      "/Music",
    );
    expect(ngrams).toContain("rock");
    expect(ngrams).toContain("pink floyd");
    expect(ngrams).toContain("wall");
  });
});

describe("tokenizeMetadata", () => {
  it("tokenizes title, artist, and album", () => {
    const ngrams = tokenizeMetadata("Song Title", "Artist Name", "Album Title");
    expect(ngrams).toContain("song");
    expect(ngrams).toContain("title");
    expect(ngrams).toContain("artist");
    expect(ngrams).toContain("name");
    expect(ngrams).toContain("album");
    expect(ngrams).toContain("song title");
    expect(ngrams).toContain("artist name");
    expect(ngrams).toContain("album title");
  });

  it("handles null fields", () => {
    const ngrams = tokenizeMetadata("Song Title", null, null);
    expect(ngrams).toContain("song");
    expect(ngrams).toContain("title");
    expect(ngrams.length).toBeGreaterThan(0);
  });
});

describe("countFrequencies", () => {
  it("counts occurrences correctly", () => {
    const freq = countFrequencies(["rock", "pop", "rock", "rock", "pop"]);
    expect(freq.get("rock")).toBe(3);
    expect(freq.get("pop")).toBe(2);
  });
});

describe("matchApprovedTags", () => {
  it("matches approved tags case-insensitively", () => {
    const ngrams = ["electronic", "deep house", "rock"];
    const approved = ["Electronic", "Deep House", "Jazz"];
    const matched = matchApprovedTags(ngrams, approved);
    expect(matched).toContain("Electronic");
    expect(matched).toContain("Deep House");
    expect(matched).not.toContain("Jazz");
  });

  it("returns original casing from approved list", () => {
    const ngrams = ["deep house"];
    const approved = ["Deep House"];
    const matched = matchApprovedTags(ngrams, approved);
    expect(matched).toEqual(["Deep House"]);
  });

  it("returns empty for no matches", () => {
    const matched = matchApprovedTags(["rock"], ["Jazz"]);
    expect(matched).toEqual([]);
  });
});
