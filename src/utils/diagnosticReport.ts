// Assembles the "Report a problem" diagnostic bundle.
//
// A user reporting "it doesn't work" costs a round trip per missing fact
// (version, OS, engine, which plugins, which companion binaries, what the
// resolver actually tried). This gathers all of them into one markdown blob
// the user reviews, copies, and pastes into a GitHub issue.
//
// Two hard rules:
//  1. Nothing is transmitted from here. The report is shown to the user; they
//     copy it and choose to submit. That review step IS the consent model, so
//     the bundle may include library metadata (titles, providers) that
//     telemetry never could — see telemetry.ts for that separate contract.
//  2. Home directories are scrubbed to `~` regardless. Usernames leak into
//     every path in a log tail, and a user skimming a wall of text will never
//     notice them.

import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { appErrorEntries, type AppErrorEntry } from "./errorLog";
import { resolverLogEntries, type ResolverLogEntry } from "./resolverLog";

export interface DiagnosticEnvironment {
  appVersion: string;
  channel: string;
  os: string;
  arch: string;
  profile: string;
  engine: string;
  mpvCapable: boolean;
  mpvVideo: boolean;
  loggingEnabled: boolean;
}

export interface DiagnosticPlugin {
  id: string;
  version?: string;
  enabled: boolean;
  status?: string;
  error?: string;
}

export interface DiagnosticDependency {
  name: string;
  status: string;
  version?: string;
  origin?: string;
}

/** Optional "what the user was doing" block, set by the entry point. */
export interface DiagnosticContext {
  title: string;
  lines: string[];
}

export interface DiagnosticInput {
  environment: DiagnosticEnvironment;
  trackCount: number | null;
  collections: string[];
  plugins: DiagnosticPlugin[];
  dependencies: DiagnosticDependency[];
  appErrors: AppErrorEntry[];
  resolverLog: ResolverLogEntry[];
  logTail: string[];
  context?: DiagnosticContext | null;
  homeDir?: string | null;
}

/** Keep the pasted report inside GitHub's comment limit with room to spare. */
const MAX_RESOLVER_ENTRIES = 25;
const MAX_ERROR_ENTRIES = 10;

/**
 * Replace the user's home directory with `~` everywhere it appears, in both
 * native and forward-slash forms (Windows logs mix them, and `file://` URLs
 * always use forward slashes).
 */
export function scrubPaths(text: string, homeDir: string | null | undefined): string {
  if (!homeDir) return text;
  const variants = new Set([homeDir, homeDir.replace(/\\/g, "/"), encodeURI(homeDir.replace(/\\/g, "/"))]);
  let out = text;
  for (const variant of variants) {
    if (!variant) continue;
    out = out.split(variant).join("~");
  }
  return out;
}

function fence(lines: string[]): string {
  // Backticks inside a log line would close the fence early; `~~~` is the
  // markdown-legal alternative and never appears in our log format.
  return ["~~~", ...lines, "~~~"].join("\n");
}

function details(summary: string, body: string): string {
  return `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

function formatErrors(errors: AppErrorEntry[]): string[] {
  return errors.slice(-MAX_ERROR_ENTRIES).flatMap((e) => {
    const head = `[${e.ts}] (${e.scope}) ${e.message}`;
    return e.stack ? [head, ...e.stack.split("\n").map((l) => `    ${l.trim()}`)] : [head];
  });
}

function formatResolverEntries(entries: ResolverLogEntry[]): string[] {
  const icon: Record<ResolverLogEntry["outcome"], string> = { ok: "OK   ", empty: "EMPTY", error: "ERROR" };
  return entries.slice(-MAX_RESOLVER_ENTRIES).map((e) => {
    const input = safeStringify(e.input);
    const suffix = e.outcome === "error" && e.error ? ` — ${e.error}` : "";
    return `${icon[e.outcome]} ${e.kind} · ${e.provider} (${e.ms}ms) ${input}${suffix}`;
  });
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    // Circular input (a resolver handed a live object) — the shape is not
    // worth failing the whole report over.
    return "[unserializable]";
  }
}

/**
 * Render the report as markdown. Pure — every input is supplied by the caller
 * so this is unit-testable and cannot itself reach the network or disk.
 */
export function buildDiagnosticReport(input: DiagnosticInput): string {
  const { environment: env } = input;
  const sections: string[] = [];

  sections.push(
    "### What happened\n\n" +
      "<!-- Replace this line: what were you doing, and what did you expect instead? -->",
  );

  if (input.context && input.context.lines.length > 0) {
    sections.push(`### ${input.context.title}\n\n${input.context.lines.map((l) => `- ${l}`).join("\n")}`);
  }

  const facts = [
    `**App**: ${env.appVersion} (${env.channel})`,
    `**OS**: ${env.os} ${env.arch}`,
    `**Engine**: ${env.engine} (libmpv ${env.mpvCapable ? "loaded" : "unavailable"}, native video ${env.mpvVideo ? "yes" : "no"})`,
    `**Library**: ${input.trackCount ?? "unknown"} tracks` +
      (input.collections.length ? ` · sources: ${input.collections.join(", ")}` : " · no sources"),
    `**Profile**: ${env.profile}`,
    `**File logging**: ${env.loggingEnabled ? "on" : "off"}`,
  ];
  sections.push(`### Environment\n\n${facts.map((f) => `- ${f}`).join("\n")}`);

  const enabledPlugins = input.plugins.filter((p) => p.enabled);
  if (enabledPlugins.length > 0) {
    const rows = enabledPlugins.map((p) => {
      const version = p.version ? ` ${p.version}` : "";
      const failed = p.status && p.status !== "loaded" ? ` — ${p.status}${p.error ? `: ${p.error}` : ""}` : "";
      return `- ${p.id}${version}${failed}`;
    });
    sections.push(`### Plugins enabled (${enabledPlugins.length})\n\n${rows.join("\n")}`);
  } else {
    sections.push("### Plugins enabled (0)\n\n- none");
  }

  if (input.dependencies.length > 0) {
    const rows = input.dependencies.map((d) => {
      if (d.status !== "installed") return `- ${d.name} — ${d.status}`;
      return `- ${d.name} ${d.version ?? "?"}${d.origin ? ` (${d.origin})` : ""}`;
    });
    sections.push(`### Companion binaries\n\n${rows.join("\n")}`);
  }

  if (input.appErrors.length > 0) {
    sections.push(
      details(
        `Recent errors (${Math.min(input.appErrors.length, MAX_ERROR_ENTRIES)})`,
        fence(formatErrors(input.appErrors)),
      ),
    );
  }

  if (input.resolverLog.length > 0) {
    sections.push(
      details(
        `Resolver activity (${Math.min(input.resolverLog.length, MAX_RESOLVER_ENTRIES)})`,
        fence(formatResolverEntries(input.resolverLog)),
      ),
    );
  }

  if (input.logTail.length > 0) {
    sections.push(details(`Log tail (${input.logTail.length} lines)`, fence(input.logTail)));
  } else if (!env.loggingEnabled) {
    sections.push(
      "> No log file — enable **Settings → Debug → Enable logging**, restart, reproduce the problem, " +
        "and attach a fresh report if the details above aren't enough.",
    );
  }

  return scrubPaths(sections.join("\n\n"), input.homeDir);
}

/** Backend facts from the `collect_diagnostics` command. */
interface DiagnosticFacts {
  os: string;
  arch: string;
  appVersion: string;
  profile: string;
  loggingEnabled: boolean;
  homeDir: string | null;
  logTail: string[];
}

export interface DiagnosticSources {
  channel: string;
  engine: string;
  mpvCapable: boolean;
  mpvVideo: boolean;
  plugins: DiagnosticPlugin[];
  dependencies: DiagnosticDependency[];
  context?: DiagnosticContext | null;
}

/**
 * Gather every input and render the report. Each lookup degrades to a
 * placeholder rather than failing — a report missing the track count still
 * beats no report, and this runs when something is already broken.
 */
export async function collectDiagnosticReport(sources: DiagnosticSources): Promise<string> {
  const [facts, fallbackVersion, trackCount, collections] = await Promise.all([
    invoke<DiagnosticFacts>("collect_diagnostics").catch((e) => {
      console.error("Failed to collect backend diagnostics:", e);
      return null;
    }),
    getVersion().catch((e) => {
      console.error("Failed to read app version:", e);
      return "unknown";
    }),
    invoke<number>("get_track_count").catch((e) => {
      console.error("Failed to read track count for diagnostics:", e);
      return null;
    }),
    invoke<Array<{ kind: string }>>("get_collections").catch((e) => {
      console.error("Failed to read collections for diagnostics:", e);
      return [] as Array<{ kind: string }>;
    }),
  ]);

  return buildDiagnosticReport({
    environment: {
      appVersion: facts?.appVersion ?? fallbackVersion,
      channel: sources.channel,
      os: facts?.os ?? "unknown",
      arch: facts?.arch ?? "unknown",
      profile: facts?.profile ?? "unknown",
      engine: sources.engine,
      mpvCapable: sources.mpvCapable,
      mpvVideo: sources.mpvVideo,
      loggingEnabled: facts?.loggingEnabled ?? false,
    },
    trackCount,
    collections: collections.map((c) => c.kind),
    plugins: sources.plugins,
    dependencies: sources.dependencies,
    appErrors: appErrorEntries(),
    resolverLog: resolverLogEntries(),
    logTail: facts?.logTail ?? [],
    context: sources.context ?? null,
    homeDir: facts?.homeDir ?? null,
  });
}

/**
 * Prefilled "new issue" URL. The report itself is NOT embedded — a full bundle
 * blows past the ~8KB practical URL limit and GitHub silently truncates it, so
 * the caller copies the report to the clipboard and the issue body just tells
 * the user to paste.
 */
export function issueUrl(issuesBase: string, title: string): string {
  const body =
    "<!-- Paste the diagnostic report here (it's already on your clipboard: Cmd/Ctrl+V). -->\n";
  return `${issuesBase}/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}
