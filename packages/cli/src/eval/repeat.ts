/**
 * Repeat-run aggregation for the A/B harness. LLM runs are stochastic, so a
 * single pass can mislead (OPEN_ITEMS §7d). Running each arm N times and
 * reporting mean ± spread (and per-task pass frequency) makes the variance
 * visible and the comparison defensible. Pure/deterministic given the runs.
 */
import type { ProviderRun } from "./runner.js";

/** Per-task frequency across N iterations of one arm. */
export interface TaskAggregate {
  taskId: string;
  runs: number;
  /** How many of the N iterations passed this task. */
  passes: number;
  /** passes / runs. */
  passRate: number;
  /** Mean (prompt+completion) tokens across iterations, when reported. */
  meanTokens?: number;
  /** Mean estimated USD cost across iterations, when priced. */
  meanCostUsd?: number;
}

/** One arm aggregated over N iterations. */
export interface ArmAggregate {
  label: string;
  runs: number;
  /** Tasks passing per iteration (length N), for spread. */
  perRunPassed: number[];
  meanPassed: number;
  minPassed: number;
  maxPassed: number;
  /** Population standard deviation of perRunPassed. */
  stdevPassed: number;
  /** Tasks per iteration (the suite size). */
  totalTasks: number;
  /** Per-task frequency, sorted by ascending pass rate then id. */
  tasks: TaskAggregate[];
  meanTokensPerTask?: number;
  meanCostPerTask?: number;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function stdev(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

/**
 * Aggregate N iterations of one arm. Each iteration is a `ProviderRun[]` (one
 * per provider); results are flattened, so a single-provider arm is the common
 * case. Task order/identity is taken from the results as they appear.
 */
export function aggregateArm(label: string, iterations: ProviderRun[][]): ArmAggregate {
  const runs = iterations.length;
  const perRun = iterations.map((it) => it.flatMap((r) => r.results));
  const perRunPassed = perRun.map((results) => results.filter((r) => r.pass).length);

  const byTask = new Map<string, { passes: number; tok: number[]; cost: number[] }>();
  const order: string[] = [];
  for (const results of perRun) {
    for (const r of results) {
      let e = byTask.get(r.taskId);
      if (!e) {
        e = { passes: 0, tok: [], cost: [] };
        byTask.set(r.taskId, e);
        order.push(r.taskId);
      }
      if (r.pass) e.passes++;
      if (r.promptTokens !== undefined || r.completionTokens !== undefined) {
        e.tok.push((r.promptTokens ?? 0) + (r.completionTokens ?? 0));
      }
      if (r.costUsd !== undefined) e.cost.push(r.costUsd);
    }
  }

  const tasks: TaskAggregate[] = order.map((taskId) => {
    const e = byTask.get(taskId)!;
    return {
      taskId,
      runs,
      passes: e.passes,
      passRate: runs > 0 ? e.passes / runs : 0,
      meanTokens: e.tok.length ? Math.round(mean(e.tok)) : undefined,
      meanCostUsd: e.cost.length ? mean(e.cost) : undefined,
    };
  });
  tasks.sort((a, b) => a.passRate - b.passRate || a.taskId.localeCompare(b.taskId));

  const tokTasks = tasks.filter((t) => t.meanTokens !== undefined);
  const costTasks = tasks.filter((t) => t.meanCostUsd !== undefined);
  return {
    label,
    runs,
    perRunPassed,
    meanPassed: mean(perRunPassed),
    minPassed: perRunPassed.length ? Math.min(...perRunPassed) : 0,
    maxPassed: perRunPassed.length ? Math.max(...perRunPassed) : 0,
    stdevPassed: stdev(perRunPassed),
    totalTasks: perRun[0]?.length ?? 0,
    tasks,
    meanTokensPerTask: tokTasks.length ? Math.round(mean(tokTasks.map((t) => t.meanTokens!))) : undefined,
    // Only report a cost/task when every task is priced (else it's a lower bound).
    meanCostPerTask:
      costTasks.length === tasks.length && tasks.length > 0
        ? mean(costTasks.map((t) => t.meanCostUsd!))
        : undefined,
  };
}

export interface RepeatColors {
  bold?: (s: string) => string;
  dim?: (s: string) => string;
  ok?: (s: string) => string;
  warn?: (s: string) => string;
  err?: (s: string) => string;
}

function usd(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function ratio(before: number, after: number): string {
  if (before <= 0 || after <= 0) return "";
  if (after < before) return `(${(before / after).toFixed(2)}x less)`;
  if (after > before) return `(${(after / before).toFixed(2)}x more)`;
  return "(same)";
}

/**
 * Render an N-run A/B comparison with variance: per-arm mean ± spread, mean
 * tokens/cost per task, the mean pass delta, and a per-task pass-rate table
 * (only rows where the two arms differ).
 */
export function formatRepeatedComparison(
  baseline: ArmAggregate,
  candidate: ArmAggregate,
  labels: { baseline?: string; candidate?: string } = {},
  c: RepeatColors = {},
): string {
  const bold = c.bold ?? ((s: string) => s);
  const dim = c.dim ?? ((s: string) => s);
  const ok = c.ok ?? ((s: string) => s);
  const err = c.err ?? ((s: string) => s);
  const a = labels.baseline ?? baseline.label;
  const b = labels.candidate ?? candidate.label;
  const n = candidate.runs;
  const lines: string[] = [];
  lines.push(bold(`A/B comparison (${n} runs) — ${a} vs ${b}`));

  const armLine = (label: string, arm: ArmAggregate): string => {
    const spread = `min ${arm.minPassed}, max ${arm.maxPassed}, \u03c3 ${arm.stdevPassed.toFixed(2)}`;
    const parts = [`mean ${arm.meanPassed.toFixed(1)}/${arm.totalTasks} passing`, `(${spread})`];
    if (arm.meanTokensPerTask !== undefined) parts.push(`\u00b7 ${arm.meanTokensPerTask} tok/task`);
    if (arm.meanCostPerTask !== undefined) parts.push(`\u00b7 ${usd(arm.meanCostPerTask)}/task`);
    return `  ${(label + ":").padEnd(10)} ${parts.join("  ")}`;
  };
  lines.push(armLine(a, baseline));
  lines.push(armLine(b, candidate));

  const passDelta = candidate.meanPassed - baseline.meanPassed;
  const deltaStr =
    passDelta > 0.0005
      ? ok(`+${passDelta.toFixed(1)} tasks (mean)`)
      : passDelta < -0.0005
        ? err(`${passDelta.toFixed(1)} tasks (mean)`)
        : dim("no net change");
  const extras: string[] = [];
  if (baseline.meanTokensPerTask !== undefined && candidate.meanTokensPerTask !== undefined) {
    extras.push(`tokens ${dim(ratio(baseline.meanTokensPerTask, candidate.meanTokensPerTask))}`);
  }
  if (baseline.meanCostPerTask !== undefined && candidate.meanCostPerTask !== undefined) {
    extras.push(`cost ${dim(ratio(baseline.meanCostPerTask, candidate.meanCostPerTask))}`);
  }
  lines.push(`  pass delta: ${deltaStr}${extras.length ? "   " + extras.join("   ") : ""}`);

  // Per-task pass rate where the arms differ.
  const candById = new Map(candidate.tasks.map((t) => [t.taskId, t]));
  const diffs = baseline.tasks
    .map((bt) => ({ bt, ct: candById.get(bt.taskId) }))
    .filter((p) => p.ct && p.ct.passes !== p.bt.passes);
  if (diffs.length > 0) {
    lines.push(dim("  per-task pass rate (differing):"));
    for (const { bt, ct } of diffs) {
      const better = ct!.passes > bt.passes;
      const mark = better ? ok("\u2191") : err("\u2193");
      lines.push(
        `    ${mark} ${bt.taskId.padEnd(20)} ${a} ${bt.passes}/${bt.runs}   ${b} ${ct!.passes}/${ct!.runs}`,
      );
    }
  } else {
    lines.push(dim("  per-task pass rate: identical across arms"));
  }
  return lines.join("\n");
}
