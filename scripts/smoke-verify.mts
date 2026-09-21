/**
 * Real-LLM smoke: confirms the verification closed-loop is wired into a live
 * session. Uses a temp Node project whose "typecheck" script is `node --check`,
 * so a successful edit passes verification. Requires a provider key.
 *
 * Run: node --import tsx scripts/smoke-verify.mts
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSession } from "../packages/cli/src/session.js";
import type { VerificationResult } from "@scissor/core";

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-vsmoke-"));
await fs.writeFile(
  path.join(workspace, "package.json"),
  JSON.stringify({ name: "tmp", scripts: { typecheck: "node --check app.js" } }, null, 2),
);

const session = await createSession({ workspaceRoot: workspace, approvalPolicy: "auto" });

let verifyRan = false;
let verifyOk = false;
const result = await session.agent.run(
  "Create app.js that prints the numbers 1, 2, 3 using console.log (valid JavaScript). Then finish.",
  {
    onAssistantText: (d) => process.stdout.write(d),
    onTurnStart: () => process.stdout.write("\n"),
    onToolStart: (c, p) => process.stdout.write(`\n[tool] ${c.name} ${p?.summary ?? ""}\n`),
    onToolEnd: (c, r) => process.stdout.write(`[${r.isError ? "err" : "ok"}] ${c.name}\n`),
    onRequestApproval: async () => "approve",
    onPresentPlan: async () => ({ action: "approve" }),
    onAskUser: async () => "proceed",
    onVerifyStart: () => {
      verifyRan = true;
      process.stdout.write("\n[verify] running...\n");
    },
    onVerifyResult: (r: VerificationResult) => {
      verifyOk = r.ok;
      process.stdout.write(`[verify] ${r.ok ? "OK" : "FAIL"}: ${r.summary}\n`);
    },
  },
);

const appExists = await fs
  .stat(path.join(workspace, "app.js"))
  .then(() => true)
  .catch(() => false);

process.stdout.write("\n");
process.stdout.write(`app.js created:   ${appExists ? "PASS" : "FAIL"}\n`);
process.stdout.write(`verification ran: ${verifyRan ? "PASS" : "FAIL"}\n`);
process.stdout.write(`verification ok:  ${verifyOk ? "PASS" : "FAIL"}\n`);
void result;

await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
if (!appExists || !verifyRan || !verifyOk) process.exit(1);
process.stdout.write("\x1b[32msmoke-verify: ALL PASS\x1b[0m\n");
