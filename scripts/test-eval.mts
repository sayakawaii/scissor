/**
 * Deterministic test: the eval harness plumbing (runner + tasks + scoring +
 * report), using an injected session factory backed by a scripted provider.
 * No network.
 *
 * Run: node --import tsx scripts/test-eval.mts
 */
import assert from "node:assert/strict";
import {
  Agent,
  defaultTools,
  type ChatParams,
  type ChatResult,
  type LLMProvider,
} from "@scissor/core";
import { runEval, type EvalSessionFactory } from "../packages/cli/src/eval/runner.js";
import { formatReport, toResultJson } from "../packages/cli/src/eval/report.js";

// A provider scripted to solve `create-file`: write hello.txt, then finish.
class CreateFileProvider implements LLMProvider {
  id = "deepseek" as const;
  model = "scripted";
  private i = 0;
  constructor(private content: string) {}
  async chat(_p: ChatParams): Promise<ChatResult> {
    this.i++;
    if (this.i === 1) {
      return {
        text: "",
        toolCalls: [
          {
            id: "w1",
            name: "write_file",
            arguments: { path: "hello.txt", content: this.content },
          },
        ],
      };
    }
    return { text: "Done.", toolCalls: [] };
  }
}

function factoryWith(content: string): EvalSessionFactory {
  return async ({ workspaceRoot }) => {
    const agent = new Agent({
      provider: new CreateFileProvider(content),
      tools: defaultTools(),
      workspaceRoot,
      approvalPolicy: "auto",
      systemPrompt: "test",
    });
    return { agent, providerId: "deepseek", model: "scripted" };
  };
}

// --- Passing run ---
{
  const runs = await runEval({
    providers: ["deepseek"],
    taskIds: ["create-file"],
    sessionFactory: factoryWith("Hello, scissor!"),
  });
  assert.equal(runs.length, 1, "one provider run");
  const r = runs[0]!;
  assert.equal(r.total, 1);
  assert.equal(r.passed, 1, "create-file passed");
  assert.equal(r.results[0]!.pass, true);
  assert.ok(r.results[0]!.turns >= 1, "records turns");

  const report = formatReport(runs);
  assert.ok(report.includes("1/1 passed"), "report shows pass rate");
  const json = JSON.parse(toResultJson(runs));
  assert.equal(json.runs[0].passed, 1, "json has results");
}

// --- Failing run: wrong file contents should be scored as a failure ---
{
  const runs = await runEval({
    providers: ["deepseek"],
    taskIds: ["create-file"],
    sessionFactory: factoryWith("wrong contents"),
  });
  assert.equal(runs[0]!.passed, 0, "wrong contents fails the check");
  assert.equal(runs[0]!.results[0]!.pass, false);
}

// --- Task filtering ---
{
  const runs = await runEval({
    providers: ["deepseek"],
    taskIds: ["nonexistent-task"],
    sessionFactory: factoryWith("x"),
  });
  assert.equal(runs[0]!.total, 0, "unknown task ids yield an empty suite");
}

process.stdout.write("\x1b[32mtest-eval: ALL PASS\x1b[0m\n");
