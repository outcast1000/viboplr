// Types for tools.mjs — the shared assistant tool catalog (see its header).

export type ToolCategory =
  | "library"
  | "playback"
  | "queue"
  | "playlists"
  | "likes"
  | "tags"
  | "info"
  | "catalog"
  | "download"
  | "files"
  | "plugins"
  | "app";

export interface ToolRequestOptions {
  timeoutMs?: number;
  raw?: boolean;
}

export interface ToolContext {
  request(method: string, path: string, body?: unknown, opts?: ToolRequestOptions): Promise<any>;
  launchApp?: () => Promise<unknown>;
  fetchLatestRelease?: () => Promise<{ version: string; url: string; publishedAt: string }>;
  mcpVersion?: string;
}

export interface CatalogTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  readOnlyWhen?: Record<string, unknown[]>;
  categories: ToolCategory[];
  transports?: string[];
  run(args: Record<string, any>, ctx: ToolContext): Promise<unknown> | unknown;
}

export interface PluginProxyTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean };
  readOnly: boolean;
  categories: ToolCategory[];
  pluginId: string;
  tool: string;
}

export interface AssistantRoster {
  plugins?: Array<{
    pluginId: string;
    name?: string;
    instructions?: string | null;
    tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> | null; readOnly?: boolean }>;
  }>;
}

export const SLOW_MS: number;
export const DEFAULT_MS: number;
export const DOWNLOAD_MS: number;
export const TOOL_CATEGORIES: ToolCategory[];
export const INSTRUCTIONS: string;
export const TOOLS: CatalogTool[];
export const PROXY_SEP: string;
export function versionCmp(a: string, b: string): number;
export function isReadOnlyCall(tool: Pick<CatalogTool, "readOnly" | "readOnlyWhen"> | null | undefined, args?: Record<string, unknown>): boolean;
export function argProblems(schema: Record<string, any> | null | undefined, args: Record<string, unknown>): string[];
export function runTool(tool: CatalogTool, args: Record<string, any> | null | undefined, ctx: ToolContext): Promise<unknown>;
export function toolsFor(transport: string): CatalogTool[];
export function buildPluginProxies(roster: AssistantRoster | null | undefined): PluginProxyTool[];
