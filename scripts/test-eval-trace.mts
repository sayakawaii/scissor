/**
 * Deterministic test: eval/bench runs feed the experience layer.
 *
 * Before this change the eval harness ran with quiet callbacks and recorded ZERO
 * `tool` events, so the offline experience report got no data from the most
 * frequent, deterministic signal source (doc §4). This test proves that when a
 * session tracer is present, an eval run records normalized tool events that map
 * cleanly into experience events (with state + per-model version) and aggregate.
 *
 * Uses a scripted provider + a real file-backed tracer; no network.
 *
 * Run: node --import tsx scripts/test-eval-trace.mts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Agent,
  aggregateExperience,
  defaultTools,
  EXPERIENCE_SCHEMA_VERSION,
  type ChatParams,
  type ChatResult,
  type LLMProvider,
} from "@scissor/core";
import { runEval, type EvalSessionFactory } from "../packages/cli/src/eval/runner.js";
import { createTracer } from "../packages/cli/src/trace.js";
import { readTraceFile } from "../packages/cli/src/trace-report.js";
import { toExperienceEvents } from "../packages/cli/src/experience-report.js";

// Scripted to solve `create-file`: write hello.txt with the expected contents,
// then finish.
class WriteThenDone implements LLMProvider {
  id = "deepseek" as const;
  model = "scripted";
  private i = 0;
  async chat(_p: ChatParams): Promise<ChatResult> {
    this.i++;
    if (this.i === 1) {
      return {
        text: "",
        toolCalls: [
          { id: "w1", name: "write_file", arguments: { path: "hello.txt", content: "Hello, scissor!" } },
        ],
      };
    }
    return { text: "Done.", toolCalls: [] };
  }
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-evaltrace-"));
const traceFile = path.join(dir, "trace.jsonl");

// Factory mirrors defaultSessionFactory but injects a scripted provider and a
// real tracer with a normalized session-start (schema + state + model).
const factory: EvalSessionFactory = async ({ workspaceRoot }) => {
  const tracer = createTracer(traceFile);
  tracer.record("session-start", {
    schemaVersion: EXPERIENCE_SCHEMA_VERSION,
    sessionId: "eval-1",
    model: "scripted",
    state: { lang: "node" },
  });
  const agent = new Agent({
    provider: new WriteThenDone(),
    tools: defaultTools(),
    workspaceRoot,
    approvalPolicy: "auto",
    systemPrompt: "test",
  });
  return { agent, providerId: "deepseek", model: "scripted", tracer };
};

const runs = await runEval({
  providers: ["deepseek"],
  taskIds: ["create-file"],
  sessionFactory: factory,
});
assert.equal(runs[0]!.passed, 1, "create-file passed");

// The run must have recorded tool events (this is what regressed before).
const events = await readTraceFile(traceFile);
const toolEvents = events.filter((e) => e.type === "tool");
assert.ok(toolEvents.length >= 1, "eval run recorded at least one tool event");
const wf = toolEvents.find((e) => e.name === "write_file")!;
assert.ok(wf, "write_file tool event recorded");
assert.equal(wf.ok, true);
assert.equal(wf.termination, "success", "success termination recorded");
assert.ok(
  events.some((e) => e.type === "session-end"),
  "tracer was closed after the task (session-end written)",
);

// End-to-end: the recorded trace maps into experience events and aggregates.
const exp = toExperienceEvents(events);
const wfExp = exp.find((e) => e.option.id === "write_file")!;
assert.ok(wfExp, "write_file mapped to an experience event");
assert.equal(wfExp.option.version, "scripted", "version = session model");
assert.deepEqual(wfExp.state, { lang: "node" }, "state carried from session-start");
assert.equal(wfExp.finalTaskOutcome, "unknown", "no verify event -> unknown final outcome");

const report = aggregateExperience(exp);
const cell = report.stats.find(
  (s) => s.optionId === "write_file" && s.stateBucket === "lang=node",
)!;
assert.ok(cell && cell.successes >= 1, "aggregated cell has the write_file success");

await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
process.stdout.write("test-eval-trace: ALL PASS\n");
