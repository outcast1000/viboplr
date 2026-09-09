// In-memory ring buffer of every toast the app shows.
//
// Toasts are the ONLY feedback for fire-and-forget flows — plugin context-menu
// actions ("No video found for X"), background failures, tail errors — and
// they vanish after 4.5s. This buffer is the durable trace: `useToasts.notify`
// records every message here, so the control API (and any assistant driving
// the app) can read what the app told the user after the fact. Same pattern as
// errorLog/resolverLog: always on, memory only, inspect via
// `window.__notifications` in devtools.

export interface NotificationLogEntry {
  seq: number;
  ts: string;
  message: string;
}

const BUFFER_LIMIT = 50;
const buffer: NotificationLogEntry[] = [];
let seq = 0;

export function recordNotification(message: string): void {
  buffer.push({ seq: ++seq, ts: new Date().toISOString(), message });
  while (buffer.length > BUFFER_LIMIT) buffer.shift();
}

/** Snapshot of the retained toasts — feeds the control API's logs.frontend. */
export function notificationLogEntries(): NotificationLogEntry[] {
  return buffer.slice();
}

if (typeof window !== "undefined") {
  (window as unknown as { __notifications: unknown }).__notifications = notificationLogEntries;
}
