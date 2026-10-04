// The real albums the demo library is built from — a few well-known records
// per decade, so "Discover by decade" and the info tabs (bios, similar
// artists, listener counts) read like a real collection. Titles and
// durations come from MusicBrainz via scripts/fetch-demo-tracklists.mjs,
// which writes demoAlbums.mjs; re-run it after editing this list.
//
// Only names are real. The audio is synthesised; covers, photos and bios are
// fetched by the app's own providers. Online lyrics providers are switched
// off in the demo profile so no real lyrics end up on the site.
//
// `tags[0]` is the genre written to the files, chosen from a few shared
// families: radio fills a station from other artists carrying the seed's
// tags, so a genre no one else has makes a one-artist station. `mood` / `bpm`
// shape the synthesised audio; `format: "flac"` makes a lossless album.

export const DEMO_ALBUM_PICKS = [
  { artist: "Miles Davis", title: "Kind of Blue", tags: ["Jazz"], mood: "minor", bpm: 72, format: "flac" },
  { artist: "John Coltrane", title: "A Love Supreme", tags: ["Jazz"], mood: "minor", bpm: 80, format: "flac" },
  { artist: "The Beatles", title: "Abbey Road", tags: ["Rock", "Pop"], mood: "major", bpm: 112 },
  { artist: "The Beach Boys", title: "Pet Sounds", tags: ["Pop", "Rock"], mood: "major", bpm: 104 },
  { artist: "Pink Floyd", title: "The Dark Side of the Moon", tags: ["Rock", "Progressive Rock"], mood: "minor", bpm: 76 },
  { artist: "Fleetwood Mac", title: "Rumours", tags: ["Rock", "Pop"], mood: "major", bpm: 118 },
  { artist: "Stevie Wonder", title: "Songs in the Key of Life", tags: ["Pop", "Soul"], mood: "major", bpm: 100 },
  { artist: "Michael Jackson", title: "Thriller", tags: ["Pop", "Funk"], mood: "minor", bpm: 118 },
  { artist: "U2", title: "The Joshua Tree", tags: ["Rock"], mood: "major", bpm: 108 },
  { artist: "Prince", title: "Purple Rain", tags: ["Pop", "Funk"], mood: "minor", bpm: 112 },
  { artist: "Nirvana", title: "Nevermind", tags: ["Rock", "Grunge"], mood: "minor", bpm: 124 },
  { artist: "Radiohead", title: "OK Computer", tags: ["Rock", "Alternative"], mood: "minor", bpm: 88 },
  { artist: "Massive Attack", title: "Mezzanine", tags: ["Electronic", "Trip Hop"], mood: "minor", bpm: 80 },
  { artist: "Radiohead", title: "Kid A", tags: ["Rock", "Electronic"], mood: "minor", bpm: 84 },
  { artist: "The Strokes", title: "Is This It", tags: ["Rock", "Indie"], mood: "major", bpm: 140 },
  { artist: "Arcade Fire", title: "Funeral", tags: ["Rock", "Indie"], mood: "major", bpm: 120 },
  { artist: "Daft Punk", title: "Random Access Memories", tags: ["Electronic", "Disco"], mood: "major", bpm: 112 },
  { artist: "Kendrick Lamar", title: "To Pimp a Butterfly", tags: ["Hip Hop"], mood: "minor", bpm: 92 },
  { artist: "Tame Impala", title: "Currents", tags: ["Rock", "Psychedelic"], mood: "major", bpm: 106 },
  { artist: "Dua Lipa", title: "Future Nostalgia", tags: ["Pop", "Disco"], mood: "minor", bpm: 120 },
  { artist: "SZA", title: "SOS", tags: ["Hip Hop", "R&B"], mood: "minor", bpm: 90 },
  { artist: "Alvvays", title: "Blue Rev", tags: ["Rock", "Indie"], mood: "major", bpm: 132 },
];
