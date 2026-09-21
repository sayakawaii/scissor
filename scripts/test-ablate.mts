/**
 * Deterministic test for the ablation matrix core (OPEN_ITEMS §7d, option C):
 * buildAblation computes per-component pass/token/cost deltas vs a full-
 * scaffolding reference, and formatAblation renders them. Pure functions, no
 * network — the `scissor ablate` command is thin orchestration over these.
 *
 * Run: node --import tsx scripts/test-ablate.mts
 */
import assert from "node:assert/strict";
import { buildAblation, formatAblation, type AblationArm } from "../packages/cli/src/eval/compare.js";
import type { ProviderRun, TaskResult } from "../packages/cli/src/eval/runner.js";

function res(
  taskId: string,
  pass: boolean,
  promptTokens: number,
  completionTokens: number,
  costUsd: number,
): TaskResult {
  return {
    taskId,
    title: taskId,
    tags: [],
    pass,
    detail: "",
    turns: 5,
    elapsedMs: 1000,
    timedOut: false,
    promptTokens,
    completionTokens,
    costUsd,
  };
}

function run(provider: string, results: TaskResult[]): ProviderRun {
  return {
    provider,
    model: "deepseek-chat",
    results,
    passed: results.filter((r) => r.pass).length,
    total: results.length,
  };
}

// Reference: full scaffolding, both tasks pass, ~10k tok/task, $0.05/task.
const reference = [
  run("deepseek", [res("a", true, 9000, 1000, 0.05), res("b", true, 9000, 1000, 0.05)]),
];

// Arm 1 — disabling repo-map keeps quality but is much cheaper (component spent
// tokens for no measured gain): passDelta 0, tokens/cost drop.
const noRepoMap = [
  run("deepseek", [res("a", true, 3000, 500, 0.02), res("b", true, 3000, 500, 0.02)]),
];
// Arm 2 — disabling the verify loop loses a task (component earned its keep):
// passDelta -1, slightly cheaper.
const noVerify = [
  run("deepseek", [res("a", true, 8000, 900, 0.045), res("b", false, 6000, 600, 0.03)]),
];

const arms: AblationArm[] = [
  { component: "repo-map", runs: noRepoMap },
  { component: "verify-loop", runs: noVerify },
];

const rows = buildAblation(reference, arms);
assert.equal(rows.length, 2, "one row per component");

const repo = rows.find((r) => r.component === "repo-map")!;
assert.equal(repo.refPass, 2, "reference passes both");
assert.equal(repo.armPass, 2, "repo-map off still passes both");
assert.equal(repo.passDelta, 0, "repo-map off: no quality change");
assert.equal(repo.refTokensPerTask, 10000, "reference tok/task");
assert.equal(repo.armTokensPerTask, 3500, "repo-map off tok/task");
assert.ok(Math.abs(repo.refCostPerTask! - 0.05) < 1e-9, "reference cost/task");
assert.ok(Math.abs(repo.armCostPerTask! - 0.02) < 1e-9, "repo-map off cost/task");

const verify = rows.find((r) => r.component === "verify-loop")!;
assert.equal(verify.passDelta, -1, "verify-loop off loses a task (it earned its keep)");

const out = formatAblation(
  { pass: 2, total: 2, tokensPerTask: 10000, costPerTask: 0.05 },
  rows,
);
assert.match(out, /Ablation matrix/, "title rendered");
assert.match(out, /reference \(full\): 2\/2 pass/, "reference summary rendered");
assert.match(out, /repo-map/, "repo-map row rendered");
assert.match(out, /10000\u21923500/, "repo-map token drop rendered");
assert.match(out, /2\/2 \(=\)/, "no-change marker for repo-map");
assert.match(out, /1\/2 \(-1\)/, "verify-loop earned-its-keep marker");

// Missing cost data degrades gracefully (n/a, no crash).
const bareRows = buildAblation(
  [run("deepseek", [{ taskId: "a", title: "a", tags: [], pass: true, detail: "", turns: 1, elapsedMs: 1, timedOut: false }])],
  [{ component: "x", runs: [run("deepseek", [{ taskId: "a", title: "a", tags: [], pass: true, detail: "", turns: 1, elapsedMs: 1, timedOut: false }])] }],
);
assert.equal(bareRows[0]!.refTokensPerTask, undefined, "no tokens -> undefined");
const bareOut = formatAblation({ pass: 1, total: 1 }, bareRows);
assert.match(bareOut, /n\/a/, "n/a rendered when unpriced/untokened");

process.stdout.write("test-ablate: ALL PASS\n");
