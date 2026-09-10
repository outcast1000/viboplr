// Pins the MCP client-config builder (utils/mcpConfig.ts). Pure: no webview,
// no invoke — the backend supplies the paths, this asserts the assembly.
import { describe, it, expect } from "vitest";
import {
  type McpSetupInfo,
  MCP_SERVER_KEY,
  buildMcpArgs,
  buildMcpConfigSnippet,
  buildMcpCliCommand,
  shellQuote,
  mcpSetupProblem,
} from "../utils/mcpConfig";

const ok: McpSetupInfo = {
  scriptPath: "/Applications/Viboplr.app/Contents/Resources/mcp/viboplr-mcp.mjs",
  nodePath: "/opt/homebrew/bin/node",
  nodeVersion: "v22.23.2",
  nodeOk: true,
  minNodeMajor: 18,
  profile: null,
};

describe("buildMcpConfigSnippet", () => {
  it("wires the resolved node and script into a valid config", () => {
    const parsed = JSON.parse(buildMcpConfigSnippet(ok)!);
    expect(parsed.mcpServers[MCP_SERVER_KEY]).toEqual({
      command: "/opt/homebrew/bin/node",
      args: [ok.scriptPath],
    });
  });

  it("emits the mcpServers wrapper so it drops into an empty config", () => {
    // Pasted into `{}` the block must be immediately valid, not a fragment.
    expect(JSON.parse(buildMcpConfigSnippet(ok)!)).toHaveProperty("mcpServers");
  });

  it("uses an absolute node path, never a bare 'node', when one was found", () => {
    // The whole point: GUI apps launch without the shell PATH, so a bare
    // "node" is the documented way this silently fails to start.
    expect(buildMcpConfigSnippet(ok)).toContain("/opt/homebrew/bin/node");
  });

  it("falls back to a bare 'node' when none was found", () => {
    const parsed = JSON.parse(buildMcpConfigSnippet({ ...ok, nodePath: null, nodeOk: false })!);
    expect(parsed.mcpServers[MCP_SERVER_KEY].command).toBe("node");
  });

  it("is null when there is no script to point at", () => {
    // Better no block than one naming a path that doesn't exist.
    expect(buildMcpConfigSnippet({ ...ok, scriptPath: null })).toBeNull();
    expect(buildMcpCliCommand({ ...ok, scriptPath: null })).toBeNull();
  });

  it("never emits --tier=full", () => {
    // The default tier is the recommendation for a Desktop client; opting in
    // is the user's call, not the button's.
    expect(buildMcpConfigSnippet(ok)).not.toContain("tier");
  });

  it("emits no profile flag on the default profile", () => {
    // The server resolves `default` itself, so the flag would be noise.
    expect(buildMcpArgs(ok)).toEqual([ok.scriptPath]);
  });

  it("passes --profile for a named profile", () => {
    // Without this a user on a named profile gets a config that connects to
    // nothing, with no hint why.
    expect(buildMcpArgs({ ...ok, profile: "perf" })).toEqual([ok.scriptPath, "--profile=perf"]);
  });
});

describe("buildMcpCliCommand", () => {
  it("produces the claude mcp add one-liner", () => {
    expect(buildMcpCliCommand(ok)).toBe(
      `claude mcp add ${MCP_SERVER_KEY} -- /opt/homebrew/bin/node ${ok.scriptPath}`,
    );
  });

  it("quotes a path containing spaces", () => {
    const win: McpSetupInfo = {
      ...ok,
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      scriptPath: "C:\\Program Files\\Viboplr\\mcp\\viboplr-mcp.mjs",
    };
    const cmd = buildMcpCliCommand(win)!;
    expect(cmd).toContain('"C:\\Program Files\\nodejs\\node.exe"');
    expect(cmd).toContain('"C:\\Program Files\\Viboplr\\mcp\\viboplr-mcp.mjs"');
  });

  it("leaves an ordinary path unquoted", () => {
    expect(shellQuote("/opt/homebrew/bin/node")).toBe("/opt/homebrew/bin/node");
  });
});

describe("mcpSetupProblem", () => {
  it("is silent when everything resolved", () => {
    expect(mcpSetupProblem(ok)).toBeNull();
  });

  it("names the version the user actually has when Node is too old", () => {
    // "No Node found" on a machine that has Node 16 is a confusing message;
    // naming 16 is what makes it actionable.
    const problem = mcpSetupProblem({ ...ok, nodeVersion: "v16.20.0", nodeOk: false })!;
    expect(problem).toContain("v16.20.0");
    expect(problem).toContain("18");
  });

  it("reports a missing Node separately from a missing script", () => {
    expect(mcpSetupProblem({ ...ok, nodePath: null, nodeVersion: null, nodeOk: false })).toMatch(/none was found/);
    expect(mcpSetupProblem({ ...ok, scriptPath: null })).toMatch(/missing from this install/);
  });
});
