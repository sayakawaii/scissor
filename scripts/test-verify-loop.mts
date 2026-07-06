/**
 * Deterministic test: verification closed-loop. A scripted provider "edits" a
 * file, declares done, and a fake verifier fails once then passes — the agent
 * must feed the failure back and re-verify until it passes. No network.
 *
 * Run: node --import tsx scripts/test-verify-loop.mts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Agent,
  defaultTools,
  type ChatParams,
  type ChatResult,
  type LLMProvider,
  type VerificationResult,
} from "@scissor/core";

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-verify-"));

// Scripted provider: returns a preset sequence of responses per chat() call.
class ScriptedProvider implements LLMProvider {
  id = "deepseek" as const;
  model = "scripted";
  private i = 0;
  constructor(private script: ChatResult[]) {}
  async chat(_p: ChatParams): Promise<ChatResult> {
    const r = this.script[this.i] ?? { text: "done", toolCalls: [] };
    this.i++;
    return r;
  }
}

const editCall = (content: string) => ({
  text: "",
  toolCalls: [
    {
      id: `c${Math.random().toString(36).slice(2)}`,
      name: "write_file",
      arguments: { path: "out.txt", content },
    },
  ],
});

const script: ChatResult[] = [
  editCall("first version"), // turn 1: edit
  { text: "done", toolCalls: [] }, // turn 2: claims done -> verify #1 (fails)
  editCall("fixed version"), // turn 3: fix after feedback
  { text: "all fixed", toolCalls: [] }, // turn 4: done -> verify #2 (passes)
];

let verifyCalls = 0;
const verify = async (): Promise<VerificationResult> => {
  verifyCalls++;
  if (verifyCalls === 1) {
    return { ok: false, summary: "typecheck failed", output: "TS1005: ';' expected" };
  }
  return { ok: true, summary: "1 check passed" };
};

const agent = new Agent({
  provider: new ScriptedProvider(script),
  tools: defaultTools(),
  workspaceRoot: workspace,
  approvalPolicy: "auto",
  verify,
  maxVerifyAttempts: 2,
});

let sawFailureFeedback = false;
const result = await agent.run("do the task", {
  onRequestApproval: async () => "approve",
});

const transcript = agent.getTranscript();
sawFailureFeedback = transcript.some(
  (m) => m.role === "user" && m.content.includes("[automated verification]"),
);
const finalContent = await fs
  .readFile(path.join(workspace, "out.txt"), "utf8")
  .catch(() => "");

assert.equal(verifyCalls, 2, "verifier ran twice (fail then pass)");
assert.ok(sawFailureFeedback, "failure was fed back to the model");
assert.equal(finalContent, "fixed version", "the fix was applied");
assert.equal(result.finalText, "all fixed", "returns final text after passing");

await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
process.stdout.write("\x1b[32mtest-verify-loop: ALL PASS\x1b[0m\n");
