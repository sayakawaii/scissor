/**
 * A/B eval harness (doc §4, §5) — compare two eval runs (a baseline vs a
 * candidate policy such as "advice on" or "route enforce") and report whether
 * the candidate helps. This is how we decide, with evidence, whether an
 * experience-layer feature should be promoted from shadow to enforce.
 *
 * Pure and deterministic: it operates on already-collected ProviderRun[] so it
 * can be unit-tested without any LLM calls.
 */
import type { ProviderRun, TaskResult } from "./runner.js";

export type ChangeKind = "fixed" | "broke" | "unchanged-pass" | "unchanged-fail";

export interface TaskChange {
  provider: string;
  taskId: string;
  before: boolean;
  after: boolean;
  kind: ChangeKind;
  turnsBefore: number;
  turnsAfter: number;
}

/** Token/cost totals for one arm, summed over the matched (compared) tasks. */
export interface ArmCost {
  tokens: number;
  costUsd: number;
  /** True only when every matched task reported an estimated cost. */
  costKnown: boolean;
  /** True when at least one matched task reported token usage. */
  tokensKnown: boolean;
}

/**
 * Trajectory-shape totals for one arm: inspected files + tool calls actually
 * used, and the oracle minimum for the same tasks. Feeds an ACRR-style
 * over-reading measure (arXiv:2607.13034) — how much context the arm pulled in
 * beyond the minimum a correct solution needs.
 */
export interface ArmReading {
  /** Sum of distinct files inspected, over tasks that reported it. */
  files: number;
  /** Sum of oracle minimum files, over tasks that carry an oracle. */
  oracleFiles: number;
  /** Sum of tool calls, over tasks that reported it. */
  toolCalls: number;
  filesKnown: boolean;
  oracleKnown: boolean;
  toolCallsKnown: boolean;
  /** Tasks counted toward these sums (matched tasks). */
  n: number;
}

export interface AbComparison {
  baselinePassed: number;
  baselineTotal: number;
  candidatePassed: number;
  candidateTotal: number;
  /** candidatePassed - baselinePassed. */
  passDelta: number;
  fixed: TaskChange[];
  broke: TaskChange[];
  changes: TaskChange[];
  turnsBefore: number;
  turnsAfter: number;
  /** Token/cost totals over matched tasks (Databricks-style cost-per-task view). */
  baselineCost: ArmCost;
  candidateCost: ArmCost;
  /** Inspected-files / oracle totals over matched tasks (ACRR over-reading view). */
  baselineReading: ArmReading;
  candidateReading: ArmReading;
  /** Tasks compared (present in both arms). */
  compared: number;
  /** Task keys present in only one arm (skipped from the comparison). */
  unmatched: string[];
}

function key(provider: string, taskId: string): string {
  return `${provider}::${taskId}`;
}

function usd(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/** Describe how the candidate (after) compares to the baseline (before). */
function ratio(before: number, after: number): string {
  if (before <= 0 || after <= 0) return "";
  if (after < before) return `(${(before / after).toFixed(2)}x less)`;
  if (after > before) return `(${(after / before).toFixed(2)}x more)`;
  return "(same)";
}

function indexRuns(runs: ProviderRun[]): Map<string, { r: TaskResult; provider: string }> {
  const m = new Map<string, { r: TaskResult; provider: string }>();
  for (const run of runs) {
    for (const r of run.results) m.set(key(run.provider, r.taskId), { r, provider: run.provider });
  }
  return m;
}

function classify(before: boolean, after: boolean): ChangeKind {
  if (before === after) return before ? "unchanged-pass" : "unchanged-fail";
  return after ? "fixed" : "broke";
}

/**
 * Compare a baseline run against a candidate run. Only tasks present in BOTH
 * arms (matched by provider + task id) are compared; others are reported as
 * unmatched and excluded from the deltas.
 */
export function compareRuns(baseline: ProviderRun[], candidate: ProviderRun[]): AbComparison {
  const base = indexRuns(baseline);
  const cand = indexRuns(candidate);

  const changes: TaskChange[] = [];
  const unmatched: string[] = [];
  let baselinePassed = 0;
  let candidatePassed = 0;
  let turnsBefore = 0;
  let turnsAfter = 0;
  const baselineCost = emptyCost();
  const candidateCost = emptyCost();
  const baselineReading = emptyReading();
  const candidateReading = emptyReading();

  const allKeys = new Set<string>([...base.keys(), ...cand.keys()]);
  const sorted = [...allKeys].sort();
  for (const k of sorted) {
    const b = base.get(k);
    const c = cand.get(k);
    if (!b || !c) {
      unmatched.push(k);
      continue;
    }
    const before = b.r.pass;
    const after = c.r.pass;
    if (before) baselinePassed++;
    if (after) candidatePassed++;
    turnsBefore += b.r.turns;
    turnsAfter += c.r.turns;
    accrueCost(baselineCost, b.r);
    accrueCost(candidateCost, c.r);
    accrueReading(baselineReading, b.r);
    accrueReading(candidateReading, c.r);
    changes.push({
      provider: b.provider,
      taskId: b.r.taskId,
      before,
      after,
      kind: classify(before, after),
      turnsBefore: b.r.turns,
      turnsAfter: c.r.turns,
    });
  }

  const compared = changes.length;
  return {
    baselinePassed,
    baselineTotal: compared,
    candidatePassed,
    candidateTotal: compared,
    passDelta: candidatePassed - baselinePassed,
    fixed: changes.filter((c) => c.kind === "fixed"),
    broke: changes.filter((c) => c.kind === "broke"),
    changes,
    turnsBefore,
    turnsAfter,
    baselineCost,
    candidateCost,
    baselineReading,
    candidateReading,
    compared,
    unmatched,
  };
}

function emptyCost(): ArmCost {
  return { tokens: 0, costUsd: 0, costKnown: true, tokensKnown: false };
}

function accrueCost(acc: ArmCost, r: TaskResult): void {
  const tok = (r.promptTokens ?? 0) + (r.completionTokens ?? 0);
  if (r.promptTokens !== undefined || r.completionTokens !== undefined) {
    acc.tokens += tok;
    acc.tokensKnown = true;
  }
  if (r.costUsd !== undefined) acc.costUsd += r.costUsd;
  else acc.costKnown = false;
}

function emptyReading(): ArmReading {
  return {
    files: 0,
    oracleFiles: 0,
    toolCalls: 0,
    filesKnown: false,
    oracleKnown: false,
    toolCallsKnown: false,
    n: 0,
  };
}

function accrueReading(acc: ArmReading, r: TaskResult): void {
  acc.n += 1;
  if (r.inspectedFiles !== undefined) {
    acc.files += r.inspectedFiles;
    acc.filesKnown = true;
  }
  if (r.toolCalls !== undefined) {
    acc.toolCalls += r.toolCalls;
    acc.toolCallsKnown = true;
  }
  if (r.oracleFiles !== undefined) {
    acc.oracleFiles += r.oracleFiles;
    acc.oracleKnown = true;
  }
}

/**
 * Agent Cognitive Redundancy Ratio on the inspected-files axis (arXiv:2607.13034):
 * (files_actual − files_min) / files_min, summed over the arm's oracle-annotated
 * tasks. 0 ≈ oracle-lean; 1 ≈ read twice the minimum; higher ≈ more over-reading.
 * Undefined when files or the oracle minimum weren't measured.
 */
export function acrrFiles(reading: ArmReading): number | undefined {
  if (!reading.filesKnown || !reading.oracleKnown || reading.oracleFiles <= 0) return undefined;
  return (reading.files - reading.oracleFiles) / reading.oracleFiles;
}

/** One row of an ablation matrix: the effect of disabling a single component. */
export interface AblationRow {
  /** Human name of the disabled component, e.g. "repo-map". */
  component: string;
  /** Tasks passing with the component ON (reference) vs OFF (arm). */
  refPass: number;
  armPass: number;
  total: number;
  /** armPass - refPass. Negative => the component was helping (removing it hurt). */
  passDelta: number;
  refTokensPerTask?: number;
  armTokensPerTask?: number;
  refCostPerTask?: number;
  armCostPerTask?: number;
  refFilesPerTask?: number;
  armFilesPerTask?: number;
  /** ACRR (files axis) with the component ON / OFF, when tasks carry an oracle. */
  refAcrr?: number;
  armAcrr?: number;
}

export interface AblationArm {
  component: string;
  runs: ProviderRun[];
}

/**
 * Build an ablation matrix: compare a full-scaffolding reference run against
 * arms that each disable one component. Rows quantify what each component
 * contributes to pass rate and what it costs in tokens/$. Pure/deterministic.
 */
export function buildAblation(reference: ProviderRun[], arms: AblationArm[]): AblationRow[] {
  return arms.map((arm) => {
    const cmp = compareRuns(reference, arm.runs);
    const n = cmp.compared || 1;
    const refTok = cmp.baselineCost.tokensKnown ? Math.round(cmp.baselineCost.tokens / n) : undefined;
    const armTok = cmp.candidateCost.tokensKnown ? Math.round(cmp.candidateCost.tokens / n) : undefined;
    const priced = cmp.baselineCost.costKnown && cmp.candidateCost.costKnown && cmp.compared > 0;
    const refFiles = cmp.baselineReading.filesKnown ? cmp.baselineReading.files / n : undefined;
    const armFiles = cmp.candidateReading.filesKnown ? cmp.candidateReading.files / n : undefined;
    return {
      component: arm.component,
      refPass: cmp.baselinePassed,
      armPass: cmp.candidatePassed,
      total: cmp.compared,
      passDelta: cmp.passDelta,
      refTokensPerTask: refTok,
      armTokensPerTask: armTok,
      refCostPerTask: priced ? cmp.baselineCost.costUsd / n : undefined,
      armCostPerTask: priced ? cmp.candidateCost.costUsd / n : undefined,
      refFilesPerTask: refFiles,
      armFilesPerTask: armFiles,
      refAcrr: acrrFiles(cmp.baselineReading),
      armAcrr: acrrFiles(cmp.candidateReading),
    };
  });
}

export interface CompareColors {
  bold?: (s: string) => string;
  dim?: (s: string) => string;
  ok?: (s: string) => string;
  warn?: (s: string) => string;
  err?: (s: string) => string;
}

/** Render an A/B comparison for the terminal. */
export function formatComparison(
  cmp: AbComparison,
  labels: { baseline?: string; candidate?: string } = {},
  c: CompareColors = {},
): string {
  const bold = c.bold ?? ((s: string) => s);
  const dim = c.dim ?? ((s: string) => s);
  const ok = c.ok ?? ((s: string) => s);
  const warn = c.warn ?? ((s: string) => s);
  const err = c.err ?? ((s: string) => s);

  const a = labels.baseline ?? "baseline";
  const b = labels.candidate ?? "candidate";
  const lines: string[] = [];
  lines.push(bold(`A/B comparison — ${a} vs ${b}`));
  lines.push(
    `  ${a}: ${cmp.baselinePassed}/${cmp.baselineTotal} · ${b}: ${cmp.candidatePassed}/${cmp.candidateTotal}`,
  );

  const deltaStr =
    cmp.passDelta > 0
      ? ok(`+${cmp.passDelta} passing`)
      : cmp.passDelta < 0
        ? err(`${cmp.passDelta} passing`)
        : dim("no net change");
  lines.push(`  pass delta: ${deltaStr}   ${dim(`turns ${cmp.turnsBefore}\u2192${cmp.turnsAfter}`)}`);

  // Databricks-style cost/quality view: tokens and est. cost per task. Only
  // meaningful when both arms reported usage over the same matched tasks.
  const n = cmp.compared || 1;
  if (cmp.baselineCost.tokensKnown && cmp.candidateCost.tokensKnown) {
    const tb = Math.round(cmp.baselineCost.tokens / n);
    const tc = Math.round(cmp.candidateCost.tokens / n);
    lines.push(`  tokens/task: ${a} ${tb}  \u2192  ${b} ${tc}   ${dim(ratio(tb, tc))}`);
  }
  if (cmp.baselineCost.costKnown && cmp.candidateCost.costKnown && cmp.compared > 0) {
    const cb = cmp.baselineCost.costUsd / n;
    const cc = cmp.candidateCost.costUsd / n;
    lines.push(`  est. cost/task: ${a} ${usd(cb)}  \u2192  ${b} ${usd(cc)}   ${dim(ratio(cb, cc))}`);
  } else if (cmp.baselineCost.tokensKnown && cmp.candidateCost.tokensKnown) {
    lines.push(dim("  est. cost/task: n/a (model has no price entry)"));
  }

  // Over-reading view (arXiv:2607.13034): files/task and, when tasks carry an
  // oracle minimum, the ACRR redundancy ratio for each arm.
  if (cmp.baselineReading.filesKnown && cmp.candidateReading.filesKnown) {
    const fb = cmp.baselineReading.files / n;
    const fc = cmp.candidateReading.files / n;
    lines.push(`  files/task: ${a} ${fb.toFixed(1)}  \u2192  ${b} ${fc.toFixed(1)}   ${dim(ratio(fb, fc))}`);
    const ab = acrrFiles(cmp.baselineReading);
    const ac = acrrFiles(cmp.candidateReading);
    if (ab !== undefined && ac !== undefined) {
      const minPerTask = cmp.baselineReading.oracleFiles / n;
      lines.push(
        `  over-read (ACRR files): ${a} ${ab.toFixed(2)}  \u2192  ${b} ${ac.toFixed(2)}   ${dim(`min ${minPerTask.toFixed(1)} file/task`)}`,
      );
    }
  }

  for (const t of cmp.fixed) {
    lines.push(`  ${ok("fixed")}  ${t.provider}/${t.taskId} ${dim(`(${t.turnsBefore}t\u2192${t.turnsAfter}t)`)}`);
  }
  for (const t of cmp.broke) {
    lines.push(`  ${err("broke")}  ${t.provider}/${t.taskId} ${dim(`(${t.turnsBefore}t\u2192${t.turnsAfter}t)`)}`);
  }
  if (cmp.fixed.length === 0 && cmp.broke.length === 0) {
    lines.push(dim("  no pass/fail changes"));
  }
  if (cmp.unmatched.length > 0) {
    lines.push(warn(`  ${cmp.unmatched.length} task(s) not present in both arms (excluded)`));
  }
  if (cmp.broke.length > 0) {
    lines.push(err(`  regression: candidate broke ${cmp.broke.length} task(s)`));
  }
  return lines.join("\n");
}

/**
 * Render an ablation matrix as a table. Each row is one component turned OFF,
 * relative to the full-scaffolding reference. A negative pass delta means the
 * component earned its keep (removing it lost tasks); a large token/cost drop
 * with a zero pass delta means the component spent tokens for no measured gain.
 */
export function formatAblation(
  reference: {
    pass: number;
    total: number;
    tokensPerTask?: number;
    costPerTask?: number;
    filesPerTask?: number;
    acrr?: number;
  },
  rows: AblationRow[],
  c: CompareColors = {},
): string {
  const bold = c.bold ?? ((s: string) => s);
  const dim = c.dim ?? ((s: string) => s);
  const ok = c.ok ?? ((s: string) => s);
  const err = c.err ?? ((s: string) => s);
  const lines: string[] = [];
  lines.push(bold("Ablation matrix — full scissor vs each component disabled"));

  const refCost = reference.costPerTask !== undefined ? usd(reference.costPerTask) : "n/a";
  const refTok = reference.tokensPerTask !== undefined ? String(reference.tokensPerTask) : "n/a";
  const refFiles = reference.filesPerTask !== undefined ? reference.filesPerTask.toFixed(1) : "n/a";
  const refAcrr = reference.acrr !== undefined ? ` · ACRR ${reference.acrr.toFixed(2)}` : "";
  lines.push(
    dim(
      `  reference (full): ${reference.pass}/${reference.total} pass · ${refTok} tok/task · ${refCost}/task · ${refFiles} files/task${refAcrr}`,
    ),
  );
  lines.push("");
  lines.push(
    dim(
      "  component off".padEnd(22) +
        "pass".padEnd(12) +
        "tok/task".padEnd(16) +
        "files/task".padEnd(14) +
        "cost/task",
    ),
  );

  for (const r of rows) {
    const passCol = `${r.armPass}/${r.total}`;
    let delta: string;
    if (r.passDelta < 0) delta = ok(` (${r.passDelta})`); // component helped
    else if (r.passDelta > 0) delta = err(` (+${r.passDelta})`); // component hurt
    else delta = dim(" (=)");
    const tok =
      r.refTokensPerTask !== undefined && r.armTokensPerTask !== undefined
        ? `${r.refTokensPerTask}\u2192${r.armTokensPerTask}`
        : "n/a";
    const files =
      r.refFilesPerTask !== undefined && r.armFilesPerTask !== undefined
        ? `${r.refFilesPerTask.toFixed(1)}\u2192${r.armFilesPerTask.toFixed(1)}`
        : "n/a";
    const cost =
      r.refCostPerTask !== undefined && r.armCostPerTask !== undefined
        ? `${usd(r.refCostPerTask)}\u2192${usd(r.armCostPerTask)}`
        : "n/a";
    lines.push(
      "  " +
        r.component.padEnd(20) +
        (passCol + delta).padEnd(20) +
        tok.padEnd(16) +
        files.padEnd(14) +
        cost,
    );
  }
  lines.push("");
  lines.push(
    dim("  pass col: value with component OFF; (\u2212n) it earned its keep, (+n) it hurt, (=) no change"),
  );
  lines.push(
    dim("  files/task + ACRR: over-reading vs oracle minimum (arXiv:2607.13034); lower is leaner"),
  );
  return lines.join("\n");
}
