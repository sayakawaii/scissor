/**
 * Verifies plan-gate behavior: a multi-step task should trigger present_plan,
 * and an edit_file should produce a colored diff preview. Auto-approves.
 *
 * Run: node --import tsx scripts/smoke-plan.mts
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

async function main() {
  const config = applyEnvOverrides(await loadConfig());
  const provider = createProvider(config, config.defaultProvider);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-plan-"));
  log("info", `provider=${provider.id} workspace=${workspace}`);

  let planSeen = false;
  let diffSeen = false;

  const callbacks: AgentCallbacks = {
    onAssistantText: (d) => process.stdout.write(d),
    onTurnStart: () => process.stdout.write("\n"),
    onToolStart: (call, preview) => {
      log("tool", `${call.name} ${preview?.summary ?? ""}`);
      if (preview?.detail?.includes("@@")) {
        diffSeen = true;
        log("diff", "unified diff preview produced");
      }
    },
    onToolEnd: (call, result) =>
      log(result.isError ? "tool-err" : "tool-ok", `${call.name}: ${result.content.split("\n")[0]}`),
    onRequestApproval: async () => "approve",
    onPresentPlan: async (summary, steps) => {
      planSeen = true;
      log("PLAN", summary || "(no summary)");
      steps.forEach((s, i) => log("PLAN", `${i + 1}. ${s}`));
      return { action: "approve" };
    },
    onAskUser: async (q) => {
      log("ask", q);
      return "Proceed with a reasonable default.";
    },
  };

  const agent = new Agent({
    provider,
    tools: defaultTools(),
    workspaceRoot: workspace,
    approvalPolicy: "plan-gate",
    maxTurns: 16,
  });

  log("test", "multi-step task: create a script, run it, then edit it");
  await agent.run(
    [
      "I want a small Node.js project. Please:",
      "1) create a file count.js that prints numbers 1 to 5, one per line;",
      "2) run it with node and confirm the output;",
      "3) then edit count.js so it prints 1 to 10 instead, and run it again to confirm.",
      "Follow your normal planning workflow.",
    ].join("\n"),
    callbacks,
  );

  const finalContent = await fs
    .readFile(path.join(workspace, "count.js"), "utf8")
    .catch(() => "<MISSING>");
  const has10 = finalContent.includes("10");

  process.stdout.write("\n");
  log("result", `present_plan invoked: ${planSeen ? "PASS" : "FAIL"}`);
  log("result", `diff preview shown:   ${diffSeen ? "PASS" : "FAIL"}`);
  log("result", `final count.js reaches 10: ${has10 ? "PASS" : "FAIL"}`);

  await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
  if (!planSeen || !diffSeen || !has10) process.exit(1);
  log("result", "ALL PASS");
}

main().catch((err) => {
  process.stderr.write(`\x1b[31mPlan smoke failed: ${err?.stack ?? err}\x1b[0m\n`);
  process.exit(1);
});
