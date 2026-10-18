// What the host's install confirmation shows for an
// `api.system.programs.download` call: read from the URL and the call's own
// options, never from anything the server sends back (the dialog comes before
// the download).

/** A plugin's description of what it installs, shown as its own words. */
export const PROGRAM_LABEL_MAX = 120;

export interface ProgramDownloadFacts {
  fileName: string;
  host: string;
  pinned: boolean;
  label: string | null;
}

/** Throws for a URL that doesn't parse; the bridge rejects with that. */
export function describeProgramDownload(url: string, opts?: { sha256?: unknown; label?: unknown }): ProgramDownloadFacts {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  const last = parsed.pathname.split("/").filter(Boolean).pop();
  let fileName = parsed.hostname;
  if (last) {
    try {
      fileName = decodeURIComponent(last);
    } catch {
      fileName = last;
    }
  }
  const label = typeof opts?.label === "string" ? opts.label.replace(/\s+/g, " ").trim() : "";
  return {
    fileName,
    host: parsed.hostname,
    pinned: typeof opts?.sha256 === "string" && opts.sha256.trim().length > 0,
    label: label ? label.slice(0, PROGRAM_LABEL_MAX) : null,
  };
}
