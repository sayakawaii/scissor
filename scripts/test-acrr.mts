/**
 * Deterministic test: ACRR over-reading metric (Phase 0 of the E3 work;
 * arXiv:2607.13034).
 *
 * The eval harness now records, per task, the distinct files the agent pulled
 * into context (inspectedFiles) and each task's oracle minimum (oracleFiles).
 * compareRuns must sum these into per-arm ArmReading totals; acrrFiles must turn
 * them into the Agent Cognitive Redundancy Ratio (files_actual − files_min) /
 * files_min; and the ab/ablate renderers must surface files/task + ACRR. This
 * is what lets us MEASURE whether scissor over-reads before we build an
 * estimator to fix it.
 *
 * Pure and network-free.
 *
 * Run: node --import tsx scripts/test-acrr.mts
 */
import assert from "node:assert/strict";
import {
  acrrFiles,
  buildAblation,
  compareRuns,
  formatAblation,
  formatComparison,
} from "../packages/cli/src/eval/compare.js";
import type { ProviderRun, TaskResult } from "../packages/cli/src/eval/runner.js";

interface Traj {
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  toolCalls?: number;
  inspectedFiles?: number;
  oracleFiles?: number;
}

function res(taskId: string, pass: boolean, turns: number, t: Traj = {}): TaskResult {
  return { taskId, title: taskId, tags: [], pass, detail: "", turns, elapsedMs: 1000, timedOut: false, ...t };
}
function run(provider: string, results: TaskResult[]): ProviderRun {
  return { provider, model: "m1", results, passed: results.filter((r) => r.pass).length, total: results.length };
}

// --- 1. compareRuns sums inspected files + oracle minima per arm ---
{
  // bare inspects ~1 file/task (lean); scissor inspects more (repo-map/retrieve
  // pull in extra files). Both tasks need exactly 1 file at the oracle.
  const bare = [
    run("gpt", [
      res("t1", true, 3, { inspectedFiles: 1, toolCalls: 2, oracleFiles: 1 }),
      res("t2", true, 4, { inspectedFiles: 2, toolCalls: 3, oracleFiles: 1 }),
    ]),
  ];
  const scissor = [
    run("gpt", [
      res("t1", true, 5, { inspectedFiles: 4, toolCalls: 7, oracleFiles: 1 }),
      res("t2", true, 6, { inspectedFiles: 6, toolCalls: 9, oracleFiles: 1 }),
    ]),
  ];
  const cmp = compareRuns(bare, scissor);

  assert.equal(cmp.baselineReading.files, 3, "bare inspected 1+2 files");
  assert.equal(cmp.candidateReading.files, 10, "scissor inspected 4+6 files");
  assert.equal(cmp.baselineReading.oracleFiles, 2, "oracle 1+1 files");
  assert.equal(cmp.candidateReading.oracleFiles, 2, "oracle carried on candidate too");
  assert.equal(cmp.baselineReading.toolCalls, 5, "bare tool calls 2+3");
  assert.equal(cmp.candidateReading.toolCalls, 16, "scissor tool calls 7+9");
  assert.ok(cmp.baselineReading.filesKnown && cmp.candidateReading.oracleKnown);

  // ACRR = (actual - min) / min, summed over the arm.
  assert.ok(Math.abs(acrrFiles(cmp.baselineReading)! - (3 - 2) / 2) < 1e-9, "bare ACRR = 0.5");
  assert.ok(Math.abs(acrrFiles(cmp.candidateReading)! - (10 - 2) / 2) < 1e-9, "scissor ACRR = 4.0");

  // Rendered report surfaces both files/task and the ACRR line.
  const out = formatComparison(cmp, { baseline: "bare", candidate: "scissor" });
  assert.match(out, /files\/task: bare 1\.5\s+→\s+scissor 5\.0/, "files/task rendered");
  assert.match(out, /over-read \(ACRR files\): bare 0\.50\s+→\s+scissor 4\.00/, "ACRR line rendered");
  assert.match(out, /min 1\.0 file\/task/, "oracle minimum shown");
}

// --- 2. acrrFiles is undefined without measurement or oracle ---
{
  assert.equal(
    acrrFiles({ files: 0, oracleFiles: 0, toolCalls: 0, filesKnown: false, oracleKnown: false, toolCallsKnown: false, n: 0 }),
    undefined,
    "no files measured -> undefined",
  );
  assert.equal(
    acrrFiles({ files: 5, oracleFiles: 0, toolCalls: 0, filesKnown: true, oracleKnown: false, toolCallsKnown: true, n: 1 }),
    undefined,
    "no oracle -> undefined",
  );
  assert.equal(
    acrrFiles({ files: 5, oracleFiles: 0, toolCalls: 0, filesKnown: true, oracleKnown: true, toolCallsKnown: true, n: 1 }),
    undefined,
    "zero oracle minimum -> undefined (no divide-by-zero)",
  );
}

// --- 3. Tasks without an oracle degrade gracefully (files line, no ACRR) ---
{
  const b = [run("gpt", [res("a", true, 3, { inspectedFiles: 1 })])];
  const c = [run("gpt", [res("a", true, 3, { inspectedFiles: 3 })])];
  const cmp = compareRuns(b, c);
  assert.equal(cmp.baselineReading.filesKnown, true, "files measured");
  assert.equal(cmp.baselineReading.oracleKnown, false, "no oracle annotation");
  const out = formatComparison(cmp, {});
  assert.match(out, /files\/task/, "files line present");
  assert.doesNotMatch(out, /ACRR/, "no ACRR line without an oracle");
}

// --- 4. Ablation matrix carries files/task + ACRR per row and reference ---
{
  // Reference (full scissor) reads 4 files/task; disabling repo-map drops it to
  // 2 with no pass loss -> repo-map was spending reads for no measured gain.
  const reference = [
    run("gpt", [
      res("t1", true, 5, { inspectedFiles: 4, oracleFiles: 1, promptTokens: 8000, completionTokens: 800, costUsd: 0.05 }),
    ]),
  ];
  const noRepomap: ProviderRun[] = [
    run("gpt", [
      res("t1", true, 4, { inspectedFiles: 2, oracleFiles: 1, promptTokens: 4000, completionTokens: 400, costUsd: 0.02 }),
    ]),
  ];
  const rows = buildAblation(reference, [{ component: "repo-map", runs: noRepomap }]);
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.refFilesPerTask, 4, "reference files/task");
  assert.equal(r.armFilesPerTask, 2, "arm files/task after disabling repo-map");
  assert.ok(Math.abs(r.refAcrr! - 3) < 1e-9, "reference ACRR = (4-1)/1 = 3");
  assert.ok(Math.abs(r.armAcrr! - 1) < 1e-9, "arm ACRR = (2-1)/1 = 1");
  assert.equal(r.passDelta, 0, "no pass change -> repo-map spent reads for no gain here");

  const table = formatAblation(
    { pass: 1, total: 1, tokensPerTask: 8800, costPerTask: 0.05, filesPerTask: 4, acrr: 3 },
    rows,
  );
  assert.match(table, /files\/task/, "files column header present");
  assert.match(table, /ACRR 3\.00/, "reference ACRR shown in header");
  assert.match(table, /4\.0→2\.0/, "per-row files/task delta shown");
}

process.stdout.write("test-acrr: ALL PASS\n");
