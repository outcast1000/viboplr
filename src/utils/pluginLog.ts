// In-memory ring buffer of plugin `api.log` lines.
//
// Those lines also go to the backend file log (`write_frontend_log`), but that
// file is OFF by default and truncated on every launch — so a plugin's own
// error report (a failed yt-dlp search, a dead API) was written nowhere most
// users, "Report a problem", or the control API could read. Same pattern as
// errorLog/resolverLog: always on, memory only, inspect via
// `window.__pluginLog` in devtools.

export interface PluginLogEntry {
  seq: number;
  ts: string;
  level: string;
  section: string;
  message: string;
}

const BUFFER_LIMIT = 200;
const buffer: PluginLogEntry[] = [];
let seq = 0;

export function recordPluginLog(level: string, message: string, section: string): void {
  buffer.push({ seq: ++seq, ts: new Date().toISOString(), level, section, message });
  while (buffer.length > BUFFER_LIMIT) buffer.shift();
}

/** Snapshot of the retained lines — feeds the diagnostic report + control API. */
export function pluginLogEntries(): PluginLogEntry[] {
  return buffer.slice();
}

if (typeof window !== "undefined") {
  (window as unknown as { __pluginLog: unknown }).__pluginLog = pluginLogEntries;
}
