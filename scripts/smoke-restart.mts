/**
 * Real-LLM smoke: confirms the agent, in self-edit mode, edits a file and then
 * drives the restart_self control tool, surfacing restartRequested. Runs in a
 * throwaway workspace (NOT scissor's real repo). Requires a provider key.
 *
 * Run: node --import tsx scripts/smoke-restart.mts
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Agent,
  applyEnvOverrides,
  createProvider,
  defaultTools,
  loadConfig,
  type AgentCallbacks,
} from "@scissor/core";

const config = applyEnvOverrides(await loadConfig());
const provider = createProvider(config, config.defaultProvider);
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-restart-"));

const callbacks: AgentCallbacks = {
  onAssistantText: (d) => process.stdout.write(d),
  onTurnStart: () => process.stdout.write("\n"),
  onToolStart: (c, p) => process.stdout.write(`\n[tool] ${c.name} ${p?.summary ?? ""}\n`),
  onToolEnd: (c, r) => process.stdout.write(`[${r.isError ? "err" : "ok"}] ${c.name}: ${r.content.split("\n")[0]}\n`),
  onRequestApproval: async () => "approve",
  onPresentPlan: async () => ({ action: "approve" }),
  onAskUser: async () => "proceed",
};

const agent = new Agent({
  provider,
  tools: defaultTools({ selfEdit: true }),
  workspaceRoot: workspace,
  approvalPolicy: "auto",
  protectedPaths: ["packages/cli/src/self/**"],
});

const result = await agent.run(
  "You are running under the supervisor in self-edit mode. Create a file note.txt containing exactly 'v2', then call restart_self with a short reason. Do this directly without presenting a plan.",
  callbacks,
);

const noteExists = await fs
  .readFile(path.join(workspace, "note.txt"), "utf8")
  .then((c) => c.includes("v2"))
  .catch(() => false);

process.stdout.write("\n");
process.stdout.write(`note.txt written: ${noteExists ? "PASS" : "FAIL"}\n`);
process.stdout.write(`restartRequested: ${result.restartRequested ? "PASS" : "FAIL"}\n`);
if (result.restartRequested) {
  process.stdout.write(`  reason: ${result.restartRequested.reason}\n`);
}

await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
if (!noteExists || !result.restartRequested) process.exit(1);
process.stdout.write("\x1b[32msmoke-restart: ALL PASS\x1b[0m\n");
