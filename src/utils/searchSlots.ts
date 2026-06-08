// Pure slot-allocation for the central / mini search surfaces.
// Decides how many of each entity type to display given a fixed total budget.

export interface SearchSlots {
  artists: number;
  albums: number;
  tracks: number;
}

const MAX_TOTAL = 7;

// Balanced: original central-search behaviour. Floors of 2 artists / 2 albums /
// 3 tracks, then leftover slots go to whichever category has more results.
export function allocateSlotsBalanced(
  artistCount: number,
  albumCount: number,
  trackCount: number,
): SearchSlots {
  let a = Math.min(artistCount, 2);
  let b = Math.min(albumCount, 2);
  let t = Math.min(trackCount, 3);

  let remaining = MAX_TOTAL - (a + b + t);
  while (remaining > 0) {
    let distributed = false;
    if (trackCount > t) { t++; remaining--; distributed = true; if (remaining <= 0) break; }
    if (albumCount > b) { b++; remaining--; distributed = true; if (remaining <= 0) break; }
    if (artistCount > a) { a++; remaining--; distributed = true; if (remaining <= 0) break; }
    if (!distributed) break;
  }
  return { artists: a, albums: b, tracks: t };
}

// Track-weighted: mini search is "find a song fast". Floors of 1 artist /
// 1 album / 4 tracks, then leftover slots prefer tracks first.
export function allocateSlotsTrackWeighted(
  artistCount: number,
  albumCount: number,
  trackCount: number,
): SearchSlots {
  let a = Math.min(artistCount, 1);
  let b = Math.min(albumCount, 1);
  let t = Math.min(trackCount, 4);

  let remaining = MAX_TOTAL - (a + b + t);
  while (remaining > 0) {
    let distributed = false;
    if (trackCount > t) { t++; remaining--; distributed = true; if (remaining <= 0) break; }
    if (artistCount > a) { a++; remaining--; distributed = true; if (remaining <= 0) break; }
    if (albumCount > b) { b++; remaining--; distributed = true; if (remaining <= 0) break; }
    if (!distributed) break;
  }
  return { artists: a, albums: b, tracks: t };
}
