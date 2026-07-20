/**
 * Deterministic test: A/B eval harness comparison (doc §4/§5).
 *
 * compareRuns is the evidence core of `scissor ab`: given a baseline run and a
 * candidate run it must correctly classify every matched task as fixed / broke /
 * unchanged, compute the pass and turns deltas, match by provider+task, exclude
 * tasks missing from either arm, and surface regressions so --strict can fail.
 *
 * Pure and network-free.
 *
 * Run: node --import tsx scripts/test-ab.mts
 */
import assert from "node:assert/strict";
import { compareRuns, formatComparison } from "../packages/cli/src/eval/compare.js";
import type { ProviderRun, TaskResult } from "../packages/cli/src/eval/runner.js";

function res(taskId: string, pass: boolean, turns: number): TaskResult {
  return { taskId, title: taskId, tags: [], pass, detail: "", turns, elapsedMs: 1000, timedOut: false };
}
function run(provider: string, results: TaskResult[]): ProviderRun {
  return { provider, model: "m1", results, passed: results.filter((r) => r.pass).length, total: results.length };
}

// Baseline: a passes, b fails, c passes, d passes. Candidate flips b->pass
// (fixed), d->fail (broke); a stays pass, c stays pass. e is candidate-only and
// z is baseline-only -> both excluded from the comparison.
const baseline = [
  run("gpt", [res("a", true, 5), res("b", false, 8), res("c", true, 4), res("d", true, 3), res("z", true, 2)]),
];
const candidate = [
  run("gpt", [res("a", true, 4), res("b", true, 6), res("c", true, 4), res("d", false, 9), res("e", true, 1)]),
];

const cmp = compareRuns(baseline, candidate);

// 1. Only matched tasks (a,b,c,d) are compared; e and z are unmatched.
assert.equal(cmp.compared, 4, "four tasks present in both arms");
assert.equal(cmp.unmatched.length, 2, "e (candidate-only) and z (baseline-only) excluded");
assert.ok(cmp.unmatched.includes("gpt::e") && cmp.unmatched.includes("gpt::z"));

// 2. Pass totals and delta computed over matched tasks only.
assert.equal(cmp.baselinePassed, 3, "baseline a,c,d pass among matched");
assert.equal(cmp.candidatePassed, 3, "candidate a,b,c pass among matched");
assert.equal(cmp.passDelta, 0, "one fixed, one broke -> net zero");

// 3. Fixed and broke correctly identified.
assert.deepEqual(cmp.fixed.map((c) => c.taskId), ["b"], "b was fixed");
assert.deepEqual(cmp.broke.map((c) => c.taskId), ["d"], "d broke");

// 4. Turns deltas captured per task and in aggregate.
const bChange = cmp.changes.find((c) => c.taskId === "b")!;
assert.equal(bChange.turnsBefore, 8);
assert.equal(bChange.turnsAfter, 6);
assert.equal(cmp.turnsBefore, 5 + 8 + 4 + 3, "sum baseline turns over matched");
assert.equal(cmp.turnsAfter, 4 + 6 + 4 + 9, "sum candidate turns over matched");

// 5. Provider matching: same task id under a different provider is NOT matched.
{
  const b2 = [run("gpt", [res("x", true, 1)])];
  const c2 = [run("claude", [res("x", false, 1)])];
  const cross = compareRuns(b2, c2);
  assert.equal(cross.compared, 0, "different providers never match");
  assert.equal(cross.unmatched.length, 2, "both reported unmatched");
}

// 6. Regression surfaced in the rendered report (feeds --strict).
const out = formatComparison(cmp, { candidate: "advice-on" });
assert.ok(out.includes("advice-on"), "candidate label rendered");
assert.ok(/broke\b/.test(out) && out.includes("regression"), "regression called out");
assert.ok(out.includes("fixed"), "fixed task listed");

// 7. A pure improvement has no regressions (so --strict would pass).
{
  const b3 = [run("gpt", [res("a", false, 5), res("b", true, 5)])];
  const c3 = [run("gpt", [res("a", true, 4), res("b", true, 5)])];
  const good = compareRuns(b3, c3);
  assert.equal(good.passDelta, 1, "one task fixed");
  assert.equal(good.broke.length, 0, "no regressions -> strict passes");
}

process.stdout.write("test-ab: ALL PASS\n");
