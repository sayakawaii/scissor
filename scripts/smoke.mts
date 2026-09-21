/**
 * Non-interactive smoke test for the scissor engine.
 * Drives the core Agent with auto-approving callbacks against a temp workspace
 * to verify the tool loop end-to-end (plan -> write -> read -> shell).
 *
 * Run: node --import tsx scripts/smoke.mts
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

function log(label: string, msg: string) {
  process.stdout.write(`\x1b[36m[${label}]\x1b[0m ${msg}\n`);
}

function autoCallbacks(): AgentCallbacks {
  return {
    onAssistantText: (d) => process.stdout.write(d),
    onTurnStart: () => process.stdout.write("\n"),
    onToolStart: (call, preview) =>
      log("tool", `${call.name} ${preview?.summary ?? ""}`),
    onToolEnd: (call, result) =>
      log(
        result.isError ? "tool-err" : "tool-ok",
        `${call.name}: ${result.content.split("\n")[0]}`,
      ),
    onRequestApproval: async () => "approve",
    onPresentPlan: async (summary, steps) => {
      log("plan", summary || "(no summary)");
      steps.forEach((s, i) => log("plan", `${i + 1}. ${s}`));
      return { action: "approve" };
    },
    onAskUser: async (q) => {
      log("ask", q);
      return "Use your best judgment and proceed.";
    },
  };
}

async function main() {
  const config = applyEnvOverrides(await loadConfig());
  const provider = createProvider(config, config.defaultProvider);
  log("info", `provider=${provider.id} model=${provider.model}`);

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-smoke-"));
  log("info", `workspace=${workspace}`);

  const agent = new Agent({
    provider,
    tools: defaultTools(),
    workspaceRoot: workspace,
    approvalPolicy: "plan-gate",
    maxTurns: 12,
  });

  // 1) Write a file.
  log("test", "1. asking agent to create hello.txt");
  await agent.run(
    'Create a file named hello.txt in the workspace whose exact contents are the single line: Hello from scissor',
    autoCallbacks(),
  );
  const helloPath = path.join(workspace, "hello.txt");
  const helloContent = await fs.readFile(helloPath, "utf8").catch(() => "<MISSING>");
  log("verify", `hello.txt => ${JSON.stringify(helloContent)}`);
  const wrote = helloContent.includes("Hello from scissor");

  // 2) Read it back.
  log("test", "2. asking agent to read hello.txt");
  const readRun = await agent.run(
    "Read hello.txt and tell me its exact contents.",
    autoCallbacks(),
  );
  const readOk = readRun.finalText.includes("Hello from scissor");

  // 3) Run a shell command.
  log("test", "3. asking agent to run a shell command");
  const shellRun = await agent.run(
    'Run the shell command "node -v" and report the exact version it prints.',
    autoCallbacks(),
  );
  const shellOk = /v?\d+\.\d+\.\d+/.test(shellRun.finalText);

  process.stdout.write("\n");
  log("result", `write_file: ${wrote ? "PASS" : "FAIL"}`);
  log("result", `read_file:  ${readOk ? "PASS" : "FAIL"}`);
  log("result", `run_shell:  ${shellOk ? "PASS" : "FAIL"}`);

  await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});

  if (!wrote || !readOk || !shellOk) process.exit(1);
  log("result", "ALL PASS");
}

main().catch((err) => {
  process.stderr.write(`\x1b[31mSmoke test failed: ${err?.stack ?? err}\x1b[0m\n`);
  process.exit(1);
});
