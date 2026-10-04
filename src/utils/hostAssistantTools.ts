// The app's own assistant tools, offered to plugins as `api.assistant.host`.
//
// This is the in-process transport for the shared catalog in mcp/tools.mjs —
// the same table the stdio MCP server serves, bound here to the
// `control_api_call` command instead of HTTP. So an in-app agent (e.g. an LLM
// plugin) sees exactly the tools an MCP client sees, and every call runs the
// same control-API handler with the same Settings → AI control write scopes.
// A tool added to tools.mjs reaches both without touching this file.
//
// Plugin-published tools come along as `<pluginId>__<tool>` entries, invoked
// through `POST /v1/assistant/invoke` rather than the plugin-to-plugin RPC on
// purpose: that route applies the "Plugin actions" gate to non-read-only
// tools, which `api.assistant.invoke` deliberately doesn't.

import { invoke } from "@tauri-apps/api/core";
import {
  INSTRUCTIONS, PROXY_SEP, buildPluginProxies, runTool, toolsFor,
  type AssistantRoster, type CatalogTool, type ToolCategory, type ToolContext,
} from "../../mcp/tools.mjs";

/** Transport name for `toolsFor` — tools that need Node (launch_app) are left out. */
const TRANSPORT = "app";

/** One tool as a plugin sees it: data only, no `run`. */
export interface HostToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  /** `{ argName: [values] }` — a call whose args match any entry is read-only. */
  readOnlyWhen?: Record<string, unknown[]>;
  categories: ToolCategory[];
  /** Set for a plugin-published tool. */
  pluginId?: string;
}

interface InProcessResponse {
  status: number;
  body: Record<string, unknown>;
}

type Invoke = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

/** `ctx.request` bound to the in-process router. Throws on a non-2xx answer,
 *  with the same "HTTP <status>: <error>" text the MCP transport produces. */
export function inProcessContext(caller: string, call: Invoke = invoke): ToolContext {
  return {
    async request(method, path, body) {
      const res = (await call("control_api_call", {
        method,
        path,
        body: body === undefined ? null : body,
        caller,
      })) as InProcessResponse;
      if (res.status < 200 || res.status >= 300) {
        const err = typeof res.body?.error === "string" ? res.body.error : JSON.stringify(res.body);
        throw new Error(`HTTP ${res.status}: ${err}`);
      }
      return res.body;
    },
  };
}

function describeCatalogTool(t: CatalogTool): HostToolInfo {
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    readOnly: t.readOnly === true,
    ...(t.readOnlyWhen ? { readOnlyWhen: t.readOnlyWhen } : {}),
    categories: t.categories,
  };
}

/** The full roster: the app's tools, then every plugin-published tool. */
export async function listHostTools(ctx: ToolContext): Promise<HostToolInfo[]> {
  const own = toolsFor(TRANSPORT).map(describeCatalogTool);
  const roster = (await ctx.request("GET", "/v1/assistant/tools")) as AssistantRoster;
  const proxies = buildPluginProxies(roster).map((p) => ({
    name: p.name,
    description: p.description,
    inputSchema: p.inputSchema,
    readOnly: p.readOnly,
    categories: p.categories,
    pluginId: p.pluginId,
  }));
  return [...own, ...proxies];
}

/** Prose for the model: what the app is and how its tools compose. */
export function hostInstructions(): string {
  return INSTRUCTIONS;
}

/** Run one tool by name. Plugin tools (`<pluginId>__<tool>`) are resolved
 *  against the live roster, like the MCP server's proxies. */
export async function invokeHostTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  if (typeof name !== "string" || !name) throw new Error("tool name is required");
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("args must be an object");
  }
  const tool = toolsFor(TRANSPORT).find((t) => t.name === name);
  if (tool) return runTool(tool, args, ctx);
  if (name.includes(PROXY_SEP)) {
    const roster = (await ctx.request("GET", "/v1/assistant/tools")) as AssistantRoster;
    const proxy = buildPluginProxies(roster).find((p) => p.name === name);
    if (proxy) {
      const out = (await ctx.request("POST", "/v1/assistant/invoke", {
        pluginId: proxy.pluginId,
        tool: proxy.tool,
        args,
      })) as { result?: unknown };
      return out?.result ?? null;
    }
  }
  throw new Error(`Unknown tool "${name}" — call listTools() for the current roster`);
}
