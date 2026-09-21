/**
 * Deterministic test: the `bare` minimal-harness baseline target + per-task
 * token/cost instrumentation (OPEN_ITEMS §7d, options A + B).
 *
 * Covers, with a scripted provider (no network):
 *  - bareTarget runs a task end-to-end with only read/write/edit/shell tools and
 *    a tiny prompt, actually applying the file change so the check passes;
 *  - it reports prompt/completion tokens, which runOneTask turns into a per-task
 *    costUsd using the model price table;
 *  - estimateCost matches the MODEL_PRICES math.
 *
 * Run: node --import tsx scripts/test-bare.mts
 */
import assert from "node:assert/strict";
import type { ChatParams, ChatResult, LLMProvider } from "@scissor/core";
import { bareTarget } from "../packages/cli/src/eval/bare.js";
import { estimateCost, runSuite, EVAL_TASKS } from "../packages/cli/src/eval/runner.js";

// Scripted provider: one write_file call (solves `create-file`), then finish.
// Reports token usage so the harness can price the task.
class WriteThenDone implements LLMProvider {
  id = "deepseek" as const;
  model = "deepseek-chat";
  private i = 0;
  async chat(_p: ChatParams): Promise<ChatResult> {
    this.i++;
    if (this.i === 1) {
      return {
        text: "",
        toolCalls: [
          { id: "w1", name: "write_file", arguments: { path: "hello.txt", content: "Hello, scissor!" } },
        ],
        usage: { promptTokens: 1000, completionTokens: 200, totalTokens: 1200 },
      };
    }
    return {
      text: "Done.",
      toolCalls: [],
      usage: { promptTokens: 500, completionTokens: 50, totalTokens: 550 },
    };
  }
}

const createFile = EVAL_TASKS.find((t) => t.id === "create-file");
assert.ok(createFile, "create-file task exists");

const target = bareTarget({ llm: new WriteThenDone(), model: "deepseek-chat" });
assert.equal(target.label, "bare", "bare target label");

const runs = await runSuite([createFile!], [target]);
const run = runs[0]!;
const r = run.results[0]!;

// 1. The minimal harness completed the task (write applied → check passes).
assert.equal(run.passed, 1, "bare harness passed create-file");
assert.equal(r.pass, true);

// 2. Tokens are reported and summed across turns (1000+200 + 500+50).
assert.equal(r.promptTokens, 1500, "prompt tokens summed across turns");
assert.equal(r.completionTokens, 250, "completion tokens summed across turns");

// 3. Cost is estimated from the model price table (deepseek-chat).
const expected = (1500 / 1e6) * 0.27 + (250 / 1e6) * 1.1;
assert.ok(r.costUsd !== undefined, "cost estimated for a priced model");
assert.ok(Math.abs(r.costUsd! - expected) < 1e-9, "cost matches price-table math");

// 4. estimateCost helper: priced vs unpriced models.
assert.equal(estimateCost("deepseek-chat", 1_000_000, 0), 0.27, "input price applied");
assert.equal(estimateCost("no-such-model-xyz", 1_000_000, 1_000_000), undefined, "unpriced -> undefined");

process.stdout.write("test-bare: ALL PASS\n");
