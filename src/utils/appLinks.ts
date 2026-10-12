/**
 * Parsing for the host's public "do this in Vibo" deep links — what a web page
 * (the Community site, first) puts behind a "Play in Vibo" / "Open in Vibo"
 * button:
 *
 *   viboplr://play?title=…&artist=…[&album=…]   play this song now
 *   viboplr://open?kind=artist&name=…           open an artist's page
 *   viboplr://open?kind=album&name=…[&artist=…] open an album's page
 *
 * Names, never ids: a link can come from any site, which knows nothing of this
 * library's rows. App.tsx resolves the names (a library copy when there is one,
 * else a metadata-only entry the stream resolvers find at play time).
 *
 * Any page can fire these, and once the user ticks the browser's "always
 * allow" nothing asks again, so neither verb may destroy anything: `play`
 * inserts after the playing entry rather than replacing the queue, and `open`
 * only navigates. There is deliberately no `enqueue` verb.
 */

export type AppLink =
  | { verb: "play"; title: string; artistName: string; albumTitle: string | null }
  | { verb: "open"; kind: "artist"; name: string }
  | { verb: "open"; kind: "album"; name: string; artistName: string | null };

/** Longer than any real title; a link carrying more is not a song name. */
const MAX_NAME = 500;

function name(params: URLSearchParams, key: string): string | null {
  const v = params.get(key)?.trim();
  if (!v || v.length > MAX_NAME) return null;
  return v;
}

export function parseAppLink(raw: string): AppLink | null {
  const m = /^viboplr:\/\/(play|open)\/?(?:\?(.*))?$/i.exec(raw.trim());
  if (!m) return null;
  const params = new URLSearchParams(m[2] ?? "");

  if (m[1].toLowerCase() === "play") {
    const title = name(params, "title");
    const artistName = name(params, "artist");
    // The resolvers search by title + artist; a title alone is too thin to
    // find the right song, so it isn't a play link.
    if (!title || !artistName) return null;
    return { verb: "play", title, artistName, albumTitle: name(params, "album") };
  }

  const n = name(params, "name");
  if (!n) return null;
  switch (params.get("kind")?.trim().toLowerCase()) {
    case "artist":
      return { verb: "open", kind: "artist", name: n };
    case "album":
      return { verb: "open", kind: "album", name: n, artistName: name(params, "artist") };
    default:
      return null;
  }
}
