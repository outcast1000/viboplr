// Structured logging for every resolver attempt + result.
//
// Stream resolvers, download providers (by-uri / by-metadata), and the
// interactive download flow all swallow failures (return null / catch +
// console.error) which makes "could not resolve" impossible to diagnose.
// `withResolverLog` wraps each resolver call at its single chokepoint so every
// attempt and outcome is logged to the console AND retained in an in-memory
// ring buffer (inspect via `window.__resolverLog` in devtools).

export type ResolverKind =
  | "stream"
  | "download:uri"
  | "download:metadata"
  | "download:search"
  | "download:resolve";

export interface ResolverLogEntry {
  seq: number;
  ts: string;
  kind: ResolverKind;
  provider: string;
  input: Record<string, unknown>;
  outcome: "ok" | "empty" | "error";
  ms: number;
  result?: unknown;
  error?: string;
}

const BUFFER_LIMIT = 200;
const buffer: ResolverLogEntry[] = [];
let seq = 0;

function record(entry: ResolverLogEntry): void {
  buffer.push(entry);
  while (buffer.length > BUFFER_LIMIT) buffer.shift();
}

// Expose the buffer + a clear() helper for live inspection in devtools.
if (typeof window !== "undefined") {
  (window as unknown as { __resolverLog: unknown }).__resolverLog = {
    entries: () => buffer.slice(),
    clear: () => { buffer.length = 0; },
  };
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// A non-null object/string result counts as a hit; null/undefined is "empty"
// (a resolver declining), which is distinct from a thrown error.
function classify(result: unknown): "ok" | "empty" {
  if (result == null) return "empty";
  if (Array.isArray(result) && result.length === 0) return "empty";
  return "ok";
}

const ICON: Record<"ok" | "empty" | "error", string> = { ok: "✓", empty: "∅", error: "✗" };
const COLOR: Record<"ok" | "empty" | "error", string> = {
  ok: "color:#5fd35f",
  empty: "color:#e6b34d",
  error: "color:#e0524d",
};

/**
 * Wrap a resolver call so its attempt and outcome are always logged + retained.
 * Re-throws on error so existing control flow (catch / fall-through) is unchanged.
 */
export async function withResolverLog<T>(
  meta: { kind: ResolverKind; provider: string; input: Record<string, unknown> },
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = now();
  // eslint-disable-next-line no-console
  console.log(`%c[resolver] ▶ ${meta.kind} · ${meta.provider}`, "color:#6cb6ff", meta.input);
  try {
    const result = await fn();
    const ms = Math.round(now() - t0);
    const outcome = classify(result);
    record({ seq: ++seq, ts: new Date().toISOString(), kind: meta.kind, provider: meta.provider, input: meta.input, outcome, ms, result });
    // eslint-disable-next-line no-console
    console.log(`%c[resolver] ${ICON[outcome]} ${meta.kind} · ${meta.provider} (${ms}ms)`, COLOR[outcome], result);
    return result;
  } catch (e) {
    const ms = Math.round(now() - t0);
    const error = e instanceof Error ? e.message : String(e);
    record({ seq: ++seq, ts: new Date().toISOString(), kind: meta.kind, provider: meta.provider, input: meta.input, outcome: "error", ms, error });
    // eslint-disable-next-line no-console
    console.error(`[resolver] ${ICON.error} ${meta.kind} · ${meta.provider} (${ms}ms)`, meta.input, e);
    throw e;
  }
}
