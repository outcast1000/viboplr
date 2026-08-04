// In-memory ring buffer of app errors, for the diagnostic report.
//
// Uncaught frontend errors are forwarded to the backend log file (App.tsx's
// window `error` / `unhandledrejection` handlers), but that file only exists
// when Settings → Debug → "Enable logging" is on, which defaults to OFF. So
// for virtually every real user the one thing worth reporting is written
// nowhere. This buffer always retains the last few errors in memory so
// "Report a problem" has something to show even with logging off.
//
// Memory-only and session-scoped by design: nothing here is persisted, and
// nothing is sent anywhere unless the user explicitly submits a report.
// Inspect live via `window.__appErrors` in devtools (mirrors resolverLog.ts).

export interface AppErrorEntry {
  seq: number;
  ts: string;
  /** Coarse origin, e.g. "window", "unhandledrejection", "playback". */
  scope: string;
  message: string;
  stack?: string;
}

const BUFFER_LIMIT = 50;
const buffer: AppErrorEntry[] = [];
let seq = 0;

export function recordAppError(scope: string, message: string, stack?: string): void {
  buffer.push({
    seq: ++seq,
    ts: new Date().toISOString(),
    scope,
    message,
    // A full stack is mostly frames from the same bundle; the head is where
    // the signal is, and it keeps the pasted report readable.
    stack: stack ? stack.split("\n").slice(0, 12).join("\n") : undefined,
  });
  while (buffer.length > BUFFER_LIMIT) buffer.shift();
}

export function appErrorEntries(): AppErrorEntry[] {
  return buffer.slice();
}

export function clearAppErrors(): void {
  buffer.length = 0;
}

if (typeof window !== "undefined") {
  (window as unknown as { __appErrors: unknown }).__appErrors = {
    entries: appErrorEntries,
    clear: clearAppErrors,
  };
}
