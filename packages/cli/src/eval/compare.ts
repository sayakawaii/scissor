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
  /** Tasks compared (present in both arms). */
  compared: number;
  /** Task keys present in only one arm (skipped from the comparison). */
  unmatched: string[];
}

function key(provider: string, taskId: string): string {
  return `${provider}::${taskId}`;
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
    compared,
    unmatched,
  };
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
