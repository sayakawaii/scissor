/**
 * Deterministic test for the benchmark harness: the agent-agnostic runSuite,
 * the scissor (in-process) target via a scripted provider, and the external
 * command-agent adapter (driving a real subprocess). No network.
 *
 * Run: node --import tsx scripts/test-bench.mts
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
} from "@scissor/core";
import {
  commandAgentFromTemplate,
  commandAgentTarget,
} from "../packages/cli/src/eval/agents.js";
import { BENCH_TASKS } from "../packages/cli/src/eval/bench-tasks.js";
import { runSuite, scissorTarget, type EvalSessionFactory } from "../packages/cli/src/eval/runner.js";
import type { EvalTask } from "../packages/cli/src/eval/tasks.js";

const task = (id: string): EvalTask => {
  const t = BENCH_TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`missing bench task ${id}`);
  return t;
};

// Helper scripts stand in for external agents. Using files (not inline `-e`)
// keeps command lines free of JS quoting so the shell:true adapter is exercised
// cleanly on both Windows and POSIX.
const helperDir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-bench-helpers-"));
async function helper(name: string, body: string): Promise<string> {
  const p = path.join(helperDir, name);
  await fs.writeFile(p, body, "utf8");
  return p;
}

// --- scissor target (in-process) via a scripted provider solving fibonacci-cli ---
{
  const CLI = [
    "const n = parseInt(process.argv[2], 10);",
    "function fib(k){let a=0,b=1;for(let i=0;i<k;i++){const t=a+b;a=b;b=t;}return a;}",
    "console.log(fib(n));",
    "",
  ].join("\n");

  class FibProvider implements LLMProvider {
    id = "deepseek" as const;
    model = "scripted";
    private i = 0;
    async chat(_p: ChatParams): Promise<ChatResult> {
      this.i++;
      if (this.i === 1) {
        return {
          text: "",
          toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "cli.js", content: CLI } }],
        };
      }
      return { text: "Done.", toolCalls: [] };
    }
  }

  const factory: EvalSessionFactory = async ({ workspaceRoot }) => ({
    agent: new Agent({
      provider: new FibProvider(),
      tools: defaultTools(),
      workspaceRoot,
      approvalPolicy: "auto",
      systemPrompt: "test",
    }),
    providerId: "deepseek",
    model: "scripted",
  });

  const runs = await runSuite([task("fibonacci-cli")], [scissorTarget("deepseek", factory)]);
  assert.equal(runs.length, 1, "one target run");
  assert.equal(runs[0]!.passed, 1, "scissor solved fibonacci-cli");
  assert.equal(runs[0]!.provider, "deepseek");
  assert.ok(runs[0]!.results[0]!.turns >= 1, "records turns");
}

// --- external command agent: writes parse.js to solve csv-sum (file-based scoring) ---
{
  const writer = await helper(
    "writer.mjs",
    [
      "import fs from 'node:fs';",
      "const rows = fs.readFileSync('data.csv','utf8').trim().split(/\\r?\\n/).slice(1);",
      "let s = 0; for (const r of rows) { if (r) s += Number(r.split(',')[1]); }",
      "fs.writeFileSync('parse.js', `const fs=require('fs');const rows=fs.readFileSync('data.csv','utf8').trim().split(/\\\\r?\\\\n/).slice(1);let s=0;for(const r of rows){if(r)s+=Number(r.split(',')[1]);}console.log(s);`);",
      "",
    ].join("\n"),
  );
  const agent = commandAgentTarget({
    label: "faux-writer",
    command: process.execPath,
    args: () => [writer],
  });

  const runs = await runSuite([task("csv-sum")], [agent]);
  assert.equal(runs[0]!.passed, 1, "command agent solved csv-sum by writing parse.js");
  assert.equal(runs[0]!.provider, "faux-writer");
}

// --- external command agent: answers via stdout (finalText scoring) ---
{
  const answerer = await helper("answer.mjs", "console.log('the version is 1.3.0');\n");
  const agent = commandAgentTarget({
    label: "faux-answerer",
    command: process.execPath,
    args: () => [answerer],
  });
  const runs = await runSuite([task("dep-version-lookup")], [agent]);
  assert.equal(runs[0]!.passed, 1, "stdout answer scored via finalText");
}

// --- external command agent failure: non-zero exit is a failed task, not a throw ---
{
  const crasher = await helper("crash.mjs", "process.exit(3);\n");
  const agent = commandAgentTarget({
    label: "faux-crasher",
    command: process.execPath,
    args: () => [crasher],
  });
  const runs = await runSuite([task("dep-version-lookup")], [agent]);
  assert.equal(runs[0]!.passed, 0, "crashing agent fails the task");
  assert.equal(runs[0]!.results[0]!.pass, false);
  assert.ok(/exit 3/.test(runs[0]!.results[0]!.detail), "surfaces exit code in detail");
}

// --- commandAgentFromTemplate substitutes {PROMPT} and runs (PATH-resolved) ---
{
  const capture: EvalTask = {
    id: "prompt-echo",
    title: "echo",
    tags: [],
    prompt: "left-pad is 1.3.0",
    async check(_dir, finalText) {
      return /1\.3\.0/.test(finalText)
        ? { pass: true, detail: "prompt reached the agent" }
        : { pass: false, detail: `got: ${finalText}` };
    },
  };
  // Bare `node` (resolved via PATH) with a space-free inline script that echoes
  // the substituted {PROMPT} back on stdout.
  const agent = commandAgentFromTemplate(
    "tmpl",
    "node -e process.stdout.write(process.argv[1]) {PROMPT}",
  );
  assert.equal(agent.label, "tmpl");
  const runs = await runSuite([capture], [agent]);
  assert.equal(runs[0]!.passed, 1, "template agent ran and {PROMPT} was substituted");
}

await fs.rm(helperDir, { recursive: true, force: true }).catch(() => {});
process.stdout.write("\x1b[32mtest-bench: ALL PASS\x1b[0m\n");
