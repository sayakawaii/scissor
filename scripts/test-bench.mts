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

// --- buried-bug-fix (Option D): the setup is buggy and the check discriminates
// the correct percentage fix from both the original bug and a hardcoded cheat ---
{
  const t = task("buried-bug-fix");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-buried-"));
  await t.setup!(dir);
  const discountPath = path.join(dir, "src/services/pricing/discount.js");

  // As-scaffolded (bug present): check must fail.
  const before = await t.check(dir, "");
  assert.equal(before.pass, false, "buried-bug-fix fails before the fix");

  // Correct percentage fix: check must pass over all varied cases.
  await fs.writeFile(
    discountPath,
    "function applyDiscount(price, pct) {\n  return (price * (100 - pct)) / 100;\n}\nmodule.exports = { applyDiscount };\n",
    "utf8",
  );
  const after = await t.check(dir, "");
  assert.equal(after.pass, true, "buried-bug-fix passes after the correct fix");

  // Hardcoding a single expected value must NOT pass (cases vary).
  await fs.writeFile(
    discountPath,
    "function applyDiscount(price, pct) {\n  return 180;\n}\nmodule.exports = { applyDiscount };\n",
    "utf8",
  );
  const cheat = await t.check(dir, "");
  assert.equal(cheat.pass, false, "hardcoded return does not satisfy the varied cases");

  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// --- deep-median-bug (Option D, harder tier): the subtle even-length bug fails
// as-scaffolded, the correct averaging fix passes, and an odd-only "fix" that
// leaves even-length wrong is rejected (probe-scored, independent of check.js) ---
{
  const t = task("deep-median-bug");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-median-"));
  await t.setup!(dir);
  const medianPath = path.join(dir, "src/analytics/summary/median.js");

  const before = await t.check(dir, "");
  assert.equal(before.pass, false, "deep-median-bug fails before the fix");

  // Correct fix: average the two middle values for even-length input.
  await fs.writeFile(
    medianPath,
    "function median(nums) {\n" +
      "  const s = [...nums].sort((a, b) => a - b);\n" +
      "  const mid = Math.floor(s.length / 2);\n" +
      "  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;\n" +
      "}\nmodule.exports = { median };\n",
    "utf8",
  );
  const after = await t.check(dir, "");
  assert.equal(after.pass, true, "deep-median-bug passes after the correct fix");

  // A change that still returns the upper-middle for even length must NOT pass.
  await fs.writeFile(
    medianPath,
    "function median(nums) {\n" +
      "  const s = [...nums].sort((a, b) => a - b);\n" +
      "  return s[Math.floor(s.length / 2)];\n" +
      "}\nmodule.exports = { median };\n",
    "utf8",
  );
  const stillWrong = await t.check(dir, "");
  assert.equal(stillWrong.pass, false, "upper-middle-only still fails even-length cases");

  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// --- omci-uint40-decode-bug (Scheme D, real-code grounded): the off-by-8 shift
// on the 40-bit path fails as-scaffolded, the correct 2**32 fix passes, and a
// hardcoded lookup is rejected (probe-scored, independent of check.js) ---
{
  const t = task("omci-uint40-decode-bug");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-uint40-"));
  await t.setup!(dir);
  const utilPath = path.join(dir, "src/service/omcianalyzer/omciSchema/util.js");

  const before = await t.check(dir, "");
  assert.equal(before.pass, false, "omci-uint40 fails before the fix");

  const correctUint40 =
    "function uint40(b) {\n" +
    "  return b[0] * 2 ** 32 + b[1] * 2 ** 24 + b[2] * 2 ** 16 + b[3] * 2 ** 8 + b[4];\n" +
    "}\n";
  const rest =
    "function uint64be(b) {\n  let v = 0;\n  for (let i = 0; i < 8; i++) v = v * 256 + b[i];\n  return v;\n}\n" +
    "function bytesUInteger(bytes, size) {\n" +
    "  if (size === 1) return bytes[0];\n" +
    "  if (size === 2) return bytes[0] * 256 + bytes[1];\n" +
    "  if (size === 4) return bytes[0] * 2 ** 24 + bytes[1] * 2 ** 16 + bytes[2] * 2 ** 8 + bytes[3];\n" +
    "  if (size === 5) return uint40(bytes);\n" +
    "  return uint64be(bytes);\n}\n" +
    "module.exports = { bytesUInteger, uint40 };\n";

  await fs.writeFile(utilPath, correctUint40 + rest, "utf8");
  const after = await t.check(dir, "");
  assert.equal(after.pass, true, "omci-uint40 passes after the correct fix");

  // A hardcoded lookup that ignores the input bytes must NOT pass the guard.
  await fs.writeFile(
    utilPath,
    "function uint40(b) {\n  const m = { '1,0,0,0,0': 4294967296, '255,255,255,255,255': 1099511627775 };\n" +
      "  return m[String(b)] || 0;\n}\n" +
      rest,
    "utf8",
  );
  const hardcoded = await t.check(dir, "");
  assert.equal(hardcoded.pass, false, "hardcoded lookup is rejected");

  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

await fs.rm(helperDir, { recursive: true, force: true }).catch(() => {});
process.stdout.write("\x1b[32mtest-bench: ALL PASS\x1b[0m\n");
