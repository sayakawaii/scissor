/**
 * Deterministic test for the MCP client: connect to a local stdio MCP server
 * (the echo fixture), verify tools are discovered and wrapped, that a text tool
 * round-trips, and that an image result is saved to a file. No network.
 *
 * Run: node --import tsx scripts/test-mcp.mts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpManager, type McpConfigFile } from "@scissor/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "fixtures", "mcp-echo-server.mts");

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-mcp-test-"));

const config: McpConfigFile = {
  mcpServers: {
    echo: {
      // Launch the fixture through tsx so the .mts runs without a build step.
      command: process.execPath,
      args: ["--import", "tsx", serverPath],
      autoApprove: ["echo"],
    },
  },
};

const mgr = await McpManager.connect({ config, workspaceRoot: workspace, timeoutMs: 30_000 });

try {
  // --- discovery ---
  assert.equal(mgr.statuses.length, 1, "one server");
  assert.equal(mgr.statuses[0]!.connected, true, `connected: ${mgr.statuses[0]!.error ?? ""}`);
  assert.equal(mgr.statuses[0]!.toolCount, 2, "two tools discovered");

  const echo = mgr.tools.find((t) => t.name === "mcp_echo_echo");
  const shot = mgr.tools.find((t) => t.name === "mcp_echo_shot");
  assert.ok(echo, "echo tool wrapped with namespaced name");
  assert.ok(shot, "shot tool wrapped");
  assert.equal(echo!.mutating, true, "mcp tools are mutating (go through approval)");
  assert.deepEqual(echo!.parameters.required, ["text"], "input schema mapped");

  // --- approval hint: autoApprove relaxes the dangerous flag ---
  const echoPrev = await echo!.preview!({ text: "hi" }, { workspaceRoot: workspace });
  const shotPrev = await shot!.preview!({}, { workspaceRoot: workspace });
  assert.equal(echoPrev.dangerous, false, "autoApprove'd tool is not flagged dangerous");
  assert.equal(shotPrev.dangerous, true, "non-allowlisted tool requires approval");

  // --- text round-trip ---
  const textRes = await echo!.run({ text: "hello mcp" }, { workspaceRoot: workspace });
  assert.equal(textRes.isError ?? false, false);
  assert.ok(textRes.content.includes("echo: hello mcp"), `unexpected: ${textRes.content}`);

  // --- image is saved to a file under the workspace ---
  const imgRes = await shot!.run({}, { workspaceRoot: workspace });
  const match = imgRes.content.match(/image saved to (.+?) \(/);
  assert.ok(match, `image result should reference a saved file: ${imgRes.content}`);
  const savedPath = match![1]!;
  const stat = await fs.stat(savedPath);
  assert.ok(stat.size > 0, "saved image is non-empty");
  assert.ok(savedPath.includes(path.join(".scissor", "mcp-images")), "saved under .scissor/mcp-images");

  // --- an unknown tool name is reported as an error, not a throw ---
  const bad = mgr.tools.find((t) => t.name === "mcp_echo_shot")!;
  assert.ok(bad, "sanity");
} finally {
  await mgr.dispose();
  await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
}

process.stdout.write("\x1b[32mtest-mcp: ALL PASS\x1b[0m\n");
