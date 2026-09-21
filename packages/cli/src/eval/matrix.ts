/**
 * Provider-comparison aggregation and reporting.
 *
 * `runEval`/`runSuite` already execute a fixed task set against a target, and
 * `repeat.ts` already aggregates N iterations of one arm. What was missing is
 * the piece that makes a *cross-model* comparison publishable: per-arm pass
 * rates with confidence intervals, cost normalization (pass-rate-per-dollar),
 * over-reading (ACRR), an explicit significance verdict, and enough provenance
 * that a third party can re-run it.
 *
 * Everything here is pure and deterministic given run data, so the whole report
 * path is testable without a provider key. Two deliberate choices keep the
 * artifact honest rather than flattering:
 *
 *  - Cost is reported ONLY when every attempt in the arm had a known price.
 *    A partially-priced arm would understate cost and inflate passes-per-dollar.
 *  - A leader is declared "significant" only when its 95% Wilson interval is
 *    disjoint from the runner-up's. Overlapping intervals report "inconclusive"
 *    — the report never implies a winner the sample size cannot support.
 */
import { wilsonInterval } from "@scissor/core";
import type { TaskResult } from "./runner.js";

/** Bumped when the JSON artifact's shape changes incompatibly. */
export const BENCHMARK_SCHEMA_VERSION = 1;

/** One arm of the comparison: a provider + the model pinned for it. */
export interface ArmSpec {
  /** Stable identifier used in the artifact and report, e.g. "nebius-nano". */
  id: string;
  provider: string;
  /** The model actually exercised. Recorded so cost math is auditable. */
  model: string;
}

/** Per-task frequency for one arm across N iterations. */
export interface TaskBreakdown {
  taskId: string;
  runs: number;
  passes: number;
  passRate: number;
  meanTokens?: number;
  meanTurns?: number;
  meanFiles?: number;
  /** Oracle minimum-sufficient file count, when the task is annotated. */
  oracleFiles?: number;
}

/** Cost figures for an arm. Present only when every attempt was priced. */
export interface ArmCost {
  totalUsd: number;
  perTaskUsd: number;
  /** Passing tasks per USD spent — the cost-efficiency headline. */
  passesPerUsd: number;
  /** USD per passing task. Undefined when the arm passed nothing. */
  usdPerPass?: number;
}

/** One arm aggregated over N iterations of the same fixed task set. */
export interface ArmSummary {
  id: string;
  provider: string;
  model: string;
  /** N: iterations of the task set. */
  runs: number;
  tasksPerRun: number;
  /** Task-runs actually observed (N x tasks, barring harness errors). */
  attempts: number;
  passes: number;
  passRate: number;
  /** 95% Wilson score interval over `attempts` Bernoulli trials. */
  ci: { low: number; high: number };
  /** Tasks passed in each iteration, exposing run-to-run spread. */
  perRunPassed: number[];
  stdevPassed: number;
  meanTurnsPerTask?: number;
  meanTokensPerTask?: number;
  meanFilesPerTask?: number;
  cost?: ArmCost;
  /** Why cost is absent, when it is. Keeps the omission auditable. */
  costNote?: string;
  /** ACRR over-reading ratio (files vs oracle minimum), oracle tasks only. */
  acrr?: { value: number; attempts: number };
  tasks: TaskBreakdown[];
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
 * Aggregate N iterations of one arm. Each iteration is the flat `TaskResult[]`
 * for the same task set, so the caller owns how runs were produced and this
 * stays a pure function of the data.
 */
export function summarizeArm(spec: ArmSpec, iterations: TaskResult[][]): ArmSummary {
  const runs = iterations.length;
  const all = iterations.flat();
  const perRunPassed = iterations.map((it) => it.filter((r) => r.pass).length);

  const byTask = new Map<
    string,
    { passes: number; runs: number; tokens: number[]; turns: number[]; files: number[]; oracleFiles?: number }
  >();
  const order: string[] = [];
  for (const r of all) {
    let e = byTask.get(r.taskId);
    if (!e) {
      e = { passes: 0, runs: 0, tokens: [], turns: [], files: [] };
      byTask.set(r.taskId, e);
      order.push(r.taskId);
    }
    e.runs++;
    if (r.pass) e.passes++;
    if (r.promptTokens !== undefined || r.completionTokens !== undefined) {
      e.tokens.push((r.promptTokens ?? 0) + (r.completionTokens ?? 0));
    }
    e.turns.push(r.turns);
    if (r.inspectedFiles !== undefined) e.files.push(r.inspectedFiles);
    if (r.oracleFiles !== undefined) e.oracleFiles = r.oracleFiles;
  }

  const tasks: TaskBreakdown[] = order.map((taskId) => {
    const e = byTask.get(taskId)!;
    return {
      taskId,
      runs: e.runs,
      passes: e.passes,
      passRate: e.runs > 0 ? e.passes / e.runs : 0,
      ...(e.tokens.length ? { meanTokens: Math.round(mean(e.tokens)) } : {}),
      ...(e.turns.length ? { meanTurns: mean(e.turns) } : {}),
      ...(e.files.length ? { meanFiles: mean(e.files) } : {}),
      ...(e.oracleFiles !== undefined ? { oracleFiles: e.oracleFiles } : {}),
    };
  });
  tasks.sort((a, b) => a.passRate - b.passRate || a.taskId.localeCompare(b.taskId));

  const attempts = all.length;
  const passes = all.filter((r) => r.pass).length;

  // Cost: only meaningful if EVERY attempt was priced, otherwise the total is a
  // lower bound and passes-per-dollar would flatter this arm.
  const priced = all.filter((r) => r.costUsd !== undefined);
  let cost: ArmCost | undefined;
  let costNote: string | undefined;
  if (attempts === 0) {
    costNote = "no attempts recorded";
  } else if (priced.length === 0) {
    costNote = `no price entry for model "${spec.model}"`;
  } else if (priced.length < attempts) {
    costNote = `only ${priced.length}/${attempts} attempts were priced`;
  } else {
    const totalUsd = priced.reduce((a, r) => a + (r.costUsd ?? 0), 0);
    cost = {
      totalUsd,
      perTaskUsd: totalUsd / attempts,
      passesPerUsd: totalUsd > 0 ? passes / totalUsd : 0,
      ...(passes > 0 ? { usdPerPass: totalUsd / passes } : {}),
    };
  }

  const tokenAttempts = all.filter(
    (r) => r.promptTokens !== undefined || r.completionTokens !== undefined,
  );
  const fileAttempts = all.filter((r) => r.inspectedFiles !== undefined);

  // ACRR: redundancy vs the oracle minimum, over attempts where both are known.
  const acrrAttempts = all.filter(
    (r) => r.inspectedFiles !== undefined && r.oracleFiles !== undefined && r.oracleFiles > 0,
  );
  const oracleTotal = acrrAttempts.reduce((a, r) => a + (r.oracleFiles ?? 0), 0);
  const filesTotal = acrrAttempts.reduce((a, r) => a + (r.inspectedFiles ?? 0), 0);

  return {
    id: spec.id,
    provider: spec.provider,
    model: spec.model,
    runs,
    tasksPerRun: iterations[0]?.length ?? 0,
    attempts,
    passes,
    passRate: attempts > 0 ? passes / attempts : 0,
    ci: wilsonInterval(passes, attempts),
    perRunPassed,
    stdevPassed: stdev(perRunPassed),
    ...(tokenAttempts.length
      ? {
          meanTokensPerTask: Math.round(
            mean(tokenAttempts.map((r) => (r.promptTokens ?? 0) + (r.completionTokens ?? 0))),
          ),
        }
      : {}),
    ...(all.length ? { meanTurnsPerTask: mean(all.map((r) => r.turns)) } : {}),
    ...(fileAttempts.length
      ? { meanFilesPerTask: mean(fileAttempts.map((r) => r.inspectedFiles ?? 0)) }
      : {}),
    ...(cost ? { cost } : {}),
    ...(costNote ? { costNote } : {}),
    ...(oracleTotal > 0
      ? { acrr: { value: (filesTotal - oracleTotal) / oracleTotal, attempts: acrrAttempts.length } }
      : {}),
    tasks,
  };
}

/** Head-to-head verdict between two arms. */
export interface PairwiseVerdict {
  a: string;
  b: string;
  /** Percentage-point difference in pass rate (a - b). */
  deltaPp: number;
  /** True when the two 95% Wilson intervals do not overlap. */
  ciDisjoint: boolean;
  verdict: "a-better" | "b-better" | "inconclusive";
}

/**
 * Compare two arms using non-overlap of their 95% Wilson intervals.
 *
 * This is a deliberately conservative screen, not a formal two-proportion test:
 * disjoint intervals imply a significant difference, but overlapping intervals
 * do NOT prove equivalence. Reporting "inconclusive" for the overlapping case is
 * the honest reading at small N.
 */
export function compareArms(a: ArmSummary, b: ArmSummary): PairwiseVerdict {
  const disjoint = a.ci.low > b.ci.high || b.ci.low > a.ci.high;
  return {
    a: a.id,
    b: b.id,
    deltaPp: (a.passRate - b.passRate) * 100,
    ciDisjoint: disjoint,
    verdict: !disjoint ? "inconclusive" : a.passRate > b.passRate ? "a-better" : "b-better",
  };
}

/** Price actually used for an arm's cost math, recorded for auditability. */
export interface PricingRecord {
  model: string;
  inputPer1M: number;
  outputPer1M: number;
}

/**
 * Everything a third party needs to reproduce the run. Deliberately excludes
 * anything machine-identifying: no absolute paths, hostnames, usernames or
 * working directories. Task `detail` strings (which can embed temp paths) are
 * aggregated away rather than copied in.
 */
export interface BenchmarkProvenance {
  /** Human label for the task set, e.g. "eval" or "eval+bench". */
  taskSet: string;
  taskIds: string[];
  runsPerArm: number;
  timeoutMs: number;
  /** Harness settings held fixed while the model varied. */
  harness: {
    router: boolean;
    experienceAdvice: boolean;
    experienceRouting: boolean;
    approvalPolicy: string;
  };
  scissorVersion: string;
  /** Commit the harness ran at, so the code under test is pinned. */
  gitCommit?: string;
  /** True when the working tree had uncommitted changes (results are unpinned). */
  gitDirty?: boolean;
  /** Major Node version, e.g. "v24" — enough to matter, not identifying. */
  nodeVersion: string;
  platform: string;
  pricing: PricingRecord[];
  /** Where the prices came from and when they were checked. */
  pricingSource: string;
}

export interface BenchmarkReport {
  schemaVersion: number;
  generatedAt: string;
  provenance: BenchmarkProvenance;
  arms: ArmSummary[];
  /** Every arm compared against the top-ranked arm. */
  pairwise: PairwiseVerdict[];
  leader: {
    armId: string;
    /** True only when the leader beats the runner-up with disjoint intervals. */
    significant: boolean;
    note: string;
  } | null;
  /** Best arm by passes-per-dollar, when cost is known for at least one arm. */
  costLeader: { armId: string; passesPerUsd: number } | null;
}

/** Assemble the full report: rank arms, compare them, and name a leader honestly. */
export function buildBenchmarkReport(input: {
  provenance: BenchmarkProvenance;
  arms: ArmSummary[];
  generatedAt?: string;
}): BenchmarkReport {
  const arms = [...input.arms].sort((a, b) => b.passRate - a.passRate || a.id.localeCompare(b.id));
  const top = arms[0];
  const runnerUp = arms[1];

  const pairwise = top ? arms.slice(1).map((arm) => compareArms(top, arm)) : [];

  let leader: BenchmarkReport["leader"] = null;
  if (top) {
    if (!runnerUp) {
      leader = {
        armId: top.id,
        significant: false,
        note: "Only one arm was run; there is nothing to compare it against.",
      };
    } else {
      const vs = compareArms(top, runnerUp);
      leader = vs.ciDisjoint
        ? {
            armId: top.id,
            significant: true,
            note:
              `${top.id} leads ${runnerUp.id} by ${vs.deltaPp.toFixed(1)} points and their 95% ` +
              `Wilson intervals are disjoint, so the ordering is supported at this sample size.`,
          }
        : {
            armId: top.id,
            significant: false,
            note:
              `${top.id} has the highest observed pass rate, but its 95% Wilson interval overlaps ` +
              `${runnerUp.id}'s. At N=${top.runs} over ${top.tasksPerRun} tasks this difference is ` +
              `NOT statistically significant — treat the ordering as unresolved, not as a winner.`,
          };
    }
  }

  const priced = arms.filter((a) => a.cost);
  const costTop = priced.length
    ? priced.reduce((best, a) => (a.cost!.passesPerUsd > best.cost!.passesPerUsd ? a : best))
    : undefined;

  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    provenance: input.provenance,
    arms,
    pairwise,
    leader,
    costLeader: costTop ? { armId: costTop.id, passesPerUsd: costTop.cost!.passesPerUsd } : null,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function usd(n: number): string {
  if (n === 0) return "$0";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function row(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

/** Render the report as publishable Markdown. */
export function formatBenchmarkMarkdown(report: BenchmarkReport): string {
  const p = report.provenance;
  const out: string[] = [];

  out.push("# scissor provider benchmark");
  out.push("");
  out.push(
    `Generated ${report.generatedAt} · task set **${p.taskSet}** (${p.taskIds.length} tasks) · ` +
      `**N = ${p.runsPerArm}** run${p.runsPerArm === 1 ? "" : "s"} per arm.`,
  );
  out.push("");

  out.push("## Method");
  out.push("");
  out.push(
    "The harness is held fixed and only the model varies. Every arm runs the same task set, " +
      "in the same scaffolding, with the same approval policy and timeout; the model router is " +
      "disabled so each arm is a single named model rather than a blend.",
  );
  out.push("");
  out.push(row(["Setting", "Value"]));
  out.push(row(["---", "---"]));
  out.push(row(["Task set", `${p.taskSet} (${p.taskIds.length} tasks)`]));
  out.push(row(["Runs per arm (N)", String(p.runsPerArm)]));
  out.push(row(["Task timeout", `${Math.round(p.timeoutMs / 1000)}s`]));
  out.push(row(["Model router", p.harness.router ? "on" : "off (model held fixed)"]));
  out.push(
    row([
      "Experience layer",
      p.harness.experienceAdvice || p.harness.experienceRouting ? "on" : "off",
    ]),
  );
  out.push(row(["Approval policy", p.harness.approvalPolicy]));
  out.push(row(["scissor version", p.scissorVersion]));
  out.push(row(["Commit", p.gitCommit ? `\`${p.gitCommit}\`${p.gitDirty ? " (dirty)" : ""}` : "unknown"]));
  out.push(row(["Runtime", `Node ${p.nodeVersion} on ${p.platform}`]));
  out.push("");
  out.push(`Tasks: ${p.taskIds.map((t) => `\`${t}\``).join(", ")}`);
  out.push("");

  out.push("## Results");
  out.push("");
  const header = [
    "Arm",
    "Model",
    "Pass rate",
    "95% CI (Wilson)",
    "Passed",
    "Tokens/task",
    "Cost/task",
    "Turns/task",
    "Files/task",
    "ACRR",
  ];
  out.push(row(header));
  out.push(row(header.map(() => "---")));
  for (const a of report.arms) {
    out.push(
      row([
        a.id,
        `\`${a.model}\``,
        pct(a.passRate),
        `${pct(a.ci.low)} – ${pct(a.ci.high)}`,
        `${a.passes}/${a.attempts}`,
        a.meanTokensPerTask !== undefined ? a.meanTokensPerTask.toLocaleString("en-US") : "—",
        a.cost ? usd(a.cost.perTaskUsd) : "—",
        a.meanTurnsPerTask !== undefined ? a.meanTurnsPerTask.toFixed(1) : "—",
        a.meanFilesPerTask !== undefined ? a.meanFilesPerTask.toFixed(1) : "—",
        a.acrr ? a.acrr.value.toFixed(2) : "—",
      ]),
    );
  }
  out.push("");

  // Per-run spread makes the variance visible rather than hiding it in a mean.
  out.push(
    "Run-to-run spread (tasks passed per iteration): " +
      report.arms
        .map((a) => `**${a.id}** ${a.perRunPassed.join(", ")} (σ ${a.stdevPassed.toFixed(2)})`)
        .join(" · "),
  );
  out.push("");

  const anyCost = report.arms.some((a) => a.cost);
  if (anyCost) {
    out.push("## Cost efficiency");
    out.push("");
    out.push(
      "Pass rate alone rewards whichever model is most expensive. Normalizing by spend is the " +
        "more decision-relevant view for anyone actually running an agent.",
    );
    out.push("");
    const ch = ["Arm", "Total cost", "Cost/task", "Cost per passing task", "Passes per $1"];
    out.push(row(ch));
    out.push(row(ch.map(() => "---")));
    for (const a of report.arms) {
      out.push(
        row([
          a.id,
          a.cost ? usd(a.cost.totalUsd) : `— (${a.costNote ?? "unpriced"})`,
          a.cost ? usd(a.cost.perTaskUsd) : "—",
          a.cost?.usdPerPass !== undefined ? usd(a.cost.usdPerPass) : "—",
          a.cost ? a.cost.passesPerUsd.toFixed(1) : "—",
        ]),
      );
    }
    out.push("");
    if (report.costLeader) {
      const arm = report.arms.find((a) => a.id === report.costLeader!.armId)!;
      out.push(
        `Best cost efficiency: **${arm.id}** at ${report.costLeader.passesPerUsd.toFixed(1)} ` +
          `passing tasks per dollar.`,
      );
      out.push("");
    }
    out.push("Prices used (USD per 1M tokens):");
    out.push("");
    const ph = ["Model", "Input", "Output"];
    out.push(row(ph));
    out.push(row(ph.map(() => "---")));
    for (const pr of p.pricing) {
      out.push(row([`\`${pr.model}\``, `$${pr.inputPer1M}`, `$${pr.outputPer1M}`]));
    }
    out.push("");
    out.push(`Price source: ${p.pricingSource}`);
    out.push("");
  }

  out.push("## Is the difference real?");
  out.push("");
  if (report.leader) {
    out.push(report.leader.note);
    out.push("");
  }
  if (report.pairwise.length > 0) {
    const vh = ["Comparison", "Δ pass rate", "95% CIs disjoint?", "Verdict"];
    out.push(row(vh));
    out.push(row(vh.map(() => "---")));
    for (const v of report.pairwise) {
      out.push(
        row([
          `${v.a} vs ${v.b}`,
          `${v.deltaPp >= 0 ? "+" : ""}${v.deltaPp.toFixed(1)} pp`,
          v.ciDisjoint ? "yes" : "no",
          v.verdict === "inconclusive" ? "inconclusive" : `${v.verdict === "a-better" ? v.a : v.b} better`,
        ]),
      );
    }
    out.push("");
  }

  out.push("## Limitations");
  out.push("");
  out.push(
    "- The Wilson interval treats the N×tasks task-runs as independent Bernoulli trials. They are " +
      "not strictly independent — the same tasks are repeated and differ in difficulty — so the " +
      "true uncertainty is **wider** than shown. Per-task counts are included below so a reader can " +
      "run a paired test instead.",
  );
  out.push(
    "- Costs are estimates: provider-reported token counts multiplied by public list prices at the " +
      "date above. They exclude cache discounts, batch rates and failed-request overhead.",
  );
  out.push(
    `- ACRR (over-reading vs the oracle minimum) is only defined for tasks carrying an oracle ` +
      `annotation, so it covers a subset of the task set.`,
  );
  out.push(
    "- All arms ran on one machine, sequentially. Wall-clock timings are therefore not comparable " +
      "across providers and are excluded from this report.",
  );
  out.push("");

  out.push("## Per-task detail");
  out.push("");
  const taskIds = [...new Set(report.arms.flatMap((a) => a.tasks.map((t) => t.taskId)))].sort();
  const th = ["Task", ...report.arms.map((a) => a.id)];
  out.push(row(th));
  out.push(row(th.map(() => "---")));
  for (const id of taskIds) {
    out.push(
      row([
        `\`${id}\``,
        ...report.arms.map((a) => {
          const t = a.tasks.find((x) => x.taskId === id);
          return t ? `${t.passes}/${t.runs}` : "—";
        }),
      ]),
    );
  }
  out.push("");

  return out.join("\n");
}
