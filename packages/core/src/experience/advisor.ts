/**
 * OaK-inspired experience layer — Advisor (doc §3.5 Planner / §5 Phase 3 建议模式).
 *
 * Turns the offline experience report into a RANKED, human-readable option
 * advisory for a given workspace state. This is "advisory mode": it produces
 * suggestions and reasons, but never decides — the existing policy (the agent /
 * LLM) still makes the final choice (doc §5 Phase 3). It is a pure read of the
 * aggregated statistics, isolated per option version and gated on confidence so
 * a thin sample never masquerades as guidance (doc §3.4, Phase 0 safe-degrade).
 */
import type { ExperienceReport, OptionStat } from "./types.js";
import { deriveStateBucket } from "./features.js";

export interface AdviceOptions {
  /** State features to advise for; when set, only the matching bucket is used. */
  state?: Record<string, string | number | boolean>;
  /** Max advisory entries to return (default 6). */
  limit?: number;
}

/** One ranked option suggestion for a state, with an explanation. */
export interface OptionAdvice {
  optionId: string;
  version: string;
  stateBucket: string;
  samples: number;
  successRate: number;
  ciLow: number;
  ciHigh: number;
  meanDurationMs: number;
  /** 1-based rank, most reliable first. */
  rank: number;
  /** Coarse reliability tier used for wording and prompt emphasis. */
  tier: "reliable" | "mixed" | "unreliable";
  /** Human-readable reason grounded in the statistics. */
  reason: string;
  /** Optional warning (e.g. the most common failure signature seen here). */
  caution?: string;
}

const DEFAULT_LIMIT = 6;
const RELIABLE_AT = 0.8;
const UNRELIABLE_AT = 0.5;

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function tierFor(rate: number): OptionAdvice["tier"] {
  if (rate >= RELIABLE_AT) return "reliable";
  if (rate < UNRELIABLE_AT) return "unreliable";
  return "mixed";
}

function adviceFrom(stat: OptionStat, rank: number): OptionAdvice {
  const tier = tierFor(stat.successRate);
  const counts = `${stat.successes}/${stat.samples} succeeded`;
  const ci = `95% CI ${pct(stat.ciLow)}-${pct(stat.ciHigh)}`;
  const reason =
    tier === "reliable"
      ? `reliable here (${counts}, ${ci})`
      : tier === "unreliable"
        ? `unreliable here (${counts}, ${ci})`
        : `mixed reliability here (${counts}, ${ci})`;
  const topError = stat.topErrors[0];
  const caution =
    tier !== "reliable" && topError
      ? `common failure: "${topError.signature}" (x${topError.count})`
      : tier !== "reliable"
        ? "verify results and consider an alternative"
        : undefined;
  return {
    optionId: stat.optionId,
    version: stat.version,
    stateBucket: stat.stateBucket,
    samples: stat.samples,
    successRate: stat.successRate,
    ciLow: stat.ciLow,
    ciHigh: stat.ciHigh,
    meanDurationMs: stat.meanDurationMs,
    rank,
    tier,
    reason,
    ...(caution ? { caution } : {}),
  };
}

/**
 * Rank options for a state by learned reliability. Only CONFIDENT cells (enough
 * samples) are advised; if `state` is given, only that bucket is considered.
 * Sorted most-reliable first (ties broken by sample count, then lower latency).
 */
export function adviseOptions(report: ExperienceReport, opts: AdviceOptions = {}): OptionAdvice[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const bucket = opts.state ? deriveStateBucket(opts.state) : undefined;

  const candidates = report.stats
    .filter((s) => s.confident)
    .filter((s) => bucket === undefined || s.stateBucket === bucket);

  candidates.sort(
    (a, b) =>
      b.successRate - a.successRate ||
      b.samples - a.samples ||
      a.meanDurationMs - b.meanDurationMs ||
      (a.optionId < b.optionId ? -1 : a.optionId > b.optionId ? 1 : 0),
  );

  return candidates.slice(0, limit).map((s, i) => adviceFrom(s, i + 1));
}

/**
 * Render advice as a compact system-prompt block, or "" when there is no
 * confident guidance (safe-degrade: inject nothing rather than noise). The block
 * explicitly frames itself as offline statistics, not rules, to keep the agent
 * as the final decider (doc §5 Phase 3).
 */
export function renderAdviceForPrompt(
  advice: OptionAdvice[],
  state?: Record<string, string | number | boolean>,
): string {
  if (advice.length === 0) return "";
  const bucket = state ? deriveStateBucket(state) : undefined;
  const lines: string[] = [
    `Experience-based guidance${bucket ? ` for this workspace (state: ${bucket})` : ""}:`,
    `These are OFFLINE success statistics from past runs, NOT rules. Weigh them, but you still decide.`,
  ];
  for (const a of advice) {
    const tail = a.caution ? ` — ${a.caution}` : "";
    lines.push(`- ${a.optionId}: ${a.reason}${tail}`);
  }
  return lines.join("\n");
}

export interface AdviceColors {
  bold?: (s: string) => string;
  dim?: (s: string) => string;
  ok?: (s: string) => string;
  warn?: (s: string) => string;
}

/** Render advice for terminal display (CLI `experience --advise`). */
export function formatAdvice(
  advice: OptionAdvice[],
  state: Record<string, string | number | boolean> | undefined,
  c: AdviceColors = {},
): string {
  const bold = c.bold ?? ((s: string) => s);
  const dim = c.dim ?? ((s: string) => s);
  const ok = c.ok ?? ((s: string) => s);
  const warn = c.warn ?? ((s: string) => s);
  const bucket = state ? deriveStateBucket(state) : undefined;

  const lines: string[] = [];
  lines.push(bold(`Experience advice${bucket ? ` for state: ${bucket}` : " (all states)"}`));
  if (advice.length === 0) {
    lines.push(
      dim("  No confident guidance yet — run more traced sessions in this kind of workspace."),
    );
    return lines.join("\n");
  }
  for (const a of advice) {
    const mark = a.tier === "reliable" ? ok("\u2713") : a.tier === "unreliable" ? warn("\u2717") : dim("~");
    lines.push(`  ${mark} ${bold(a.optionId)}  ${dim(a.reason)}`);
    if (a.caution) lines.push(`      ${warn(a.caution)}`);
  }
  return lines.join("\n");
}
