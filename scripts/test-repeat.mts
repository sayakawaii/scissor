/**
 * Deterministic test for the N-run aggregation (OPEN_ITEMS §7d): aggregateArm
 * computes per-task pass frequency + mean tokens/cost and per-arm mean/min/max/
 * stdev of tasks passed; formatRepeatedComparison surfaces variance and the
 * per-task differences. Pure functions, no network.
 *
 * Run: node --import tsx scripts/test-repeat.mts
 */
import assert from "node:assert/strict";
import { aggregateArm, formatRepeatedComparison } from "../packages/cli/src/eval/repeat.js";
import type { ProviderRun, TaskResult } from "../packages/cli/src/eval/runner.js";

function res(taskId: string, pass: boolean, tok: number, cost: number): TaskResult {
  return {
    taskId,
    title: taskId,
    tags: [],
    pass,
    detail: "",
    turns: 5,
    elapsedMs: 1000,
    timedOut: false,
    promptTokens: Math.round(tok * 0.9),
    completionTokens: Math.round(tok * 0.1),
    costUsd: cost,
  };
}

function iter(results: TaskResult[]): ProviderRun[] {
  return [{ provider: "deepseek", model: "deepseek-chat", results, passed: results.filter((r) => r.pass).length, total: results.length }];
}

// Baseline over 3 iterations, tasks a & b, with variance in tasks-passed.
const baseIters = [
  iter([res("a", true, 5000, 0.02), res("b", true, 5000, 0.02)]), // 2 passed
  iter([res("a", true, 5000, 0.02), res("b", false, 5000, 0.02)]), // 1 passed
  iter([res("a", false, 5000, 0.02), res("b", false, 5000, 0.02)]), // 0 passed
];
// Candidate: everything passes every run, but ~2x the tokens/cost.
const candIters = [
  iter([res("a", true, 10000, 0.04), res("b", true, 10000, 0.04)]),
  iter([res("a", true, 10000, 0.04), res("b", true, 10000, 0.04)]),
  iter([res("a", true, 10000, 0.04), res("b", true, 10000, 0.04)]),
];

const base = aggregateArm("bare", baseIters);
const cand = aggregateArm("scissor", candIters);

// Per-arm spread.
assert.deepEqual(base.perRunPassed, [2, 1, 0], "baseline tasks-passed per run");
assert.equal(base.meanPassed, 1, "baseline mean passed");
assert.equal(base.minPassed, 0);
assert.equal(base.maxPassed, 2);
assert.ok(Math.abs(base.stdevPassed - Math.sqrt(2 / 3)) < 1e-9, "population stdev");
assert.equal(cand.meanPassed, 2, "candidate always passes both");
assert.equal(cand.stdevPassed, 0, "candidate has no variance");

// Per-task frequency.
const bt = Object.fromEntries(base.tasks.map((t) => [t.taskId, t]));
assert.equal(bt.a!.passes, 2, "task a passes 2/3");
assert.equal(bt.b!.passes, 1, "task b passes 1/3");
assert.ok(Math.abs(bt.a!.passRate - 2 / 3) < 1e-9, "task a pass rate");
assert.equal(bt.a!.meanTokens, 5000, "mean tokens per task instance");

// Mean tokens/cost per task and totals.
assert.equal(base.meanTokensPerTask, 5000, "baseline mean tok/task");
assert.equal(cand.meanTokensPerTask, 10000, "candidate mean tok/task");
assert.ok(Math.abs(base.meanCostPerTask! - 0.02) < 1e-9, "baseline mean cost/task");
assert.ok(Math.abs(cand.meanCostPerTask! - 0.04) < 1e-9, "candidate mean cost/task");

// Formatter surfaces variance, the mean delta, cost ratio, and per-task diffs.
const out = formatRepeatedComparison(base, cand, {});
assert.match(out, /A\/B comparison \(3 runs\)/, "run count in header");
assert.match(out, /mean 1\.0\/2 passing/, "baseline mean rendered");
assert.match(out, /min 0, max 2, σ 0\.82/, "baseline spread rendered");
assert.match(out, /mean 2\.0\/2 passing/, "candidate mean rendered");
assert.match(out, /\+1\.0 tasks \(mean\)/, "mean pass delta rendered");
assert.match(out, /2\.00x more/, "token/cost ratio rendered");
assert.match(out, /per-task pass rate \(differing\)/, "per-task diffs section");
assert.match(out, /a\s+bare 2\/3\s+scissor 3\/3/, "task a diff row");

// Identical arms -> no differing rows.
const same = formatRepeatedComparison(base, base, {});
assert.match(same, /identical across arms/, "identical arms noted");

process.stdout.write("test-repeat: ALL PASS\n");
