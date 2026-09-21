/**
 * OaK-inspired experience layer — human-readable report (doc §8 acceptance #2).
 *
 * The formatter is deliberately blunt about sample size and confidence: an
 * option's success rate is only useful if the reader can see how many samples
 * back it and how wide the interval is. Low-sample cells are marked so a thin
 * signal is never mistaken for a reliable one. Colors are injected so this stays
 * UI-agnostic (matches trace-report.ts's `formatTraceReport` style).
 */
import type { ExperienceReport, OptionStat } from "./types.js";

export interface ReportColors {
  bold?: (s: string) => string;
  dim?: (s: string) => string;
  ok?: (s: string) => string;
  warn?: (s: string) => string;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statLine(s: OptionStat, c: Required<ReportColors>): string {
  const rate = `${pct(s.successRate)} (${s.successes}/${s.samples})`;
  const ci = `[${pct(s.ciLow)}-${pct(s.ciHigh)}]`;
  const cost = s.meanUsd > 0 ? `  ~$${s.meanUsd.toFixed(4)}` : "";
  const flag = s.confident ? "" : c.warn(" low-sample");
  const head = `  ${s.optionId}@${s.version}`;
  const body = `${rate} ${c.dim(ci)}  ${fmtMs(s.meanDurationMs)}${cost}${flag}`;
  const state = c.dim(`state=${s.stateBucket}`);
  const errs =
    s.topErrors.length > 0
      ? "\n      " + c.dim(`errors: ${s.topErrors.map((e) => `${e.signature} x${e.count}`).join("  ·  ")}`)
      : "";
  return `${head}  ${body}\n      ${state}${errs}`;
}

/**
 * Filter an experience report to keep only option/state cells whose successRate
 * is strictly below `rate` (a fraction between 0 and 1), sorted by successRate
 * ascending (flakiest first). Returns a new ExperienceReport with the filtered
 * stats array; all other fields (events, tasks, minSamples) are preserved.
 * stateConditioned findings that reference filtered-out cells are also dropped.
 */
export function filterFailingStats(report: ExperienceReport, rate: number): ExperienceReport {
  const filtered = report.stats
    .filter((s) => s.successRate < rate)
    .sort((a, b) => a.successRate - b.successRate || a.optionId.localeCompare(b.optionId));

  // Only keep stateConditioned findings whose both buckets still exist in filtered.
  const keepBuckets = new Set(filtered.map((s) => `${s.optionId}\u0000${s.version}\u0000${s.stateBucket}`));
  const sc = report.stateConditioned.filter(
    (f) =>
      keepBuckets.has(`${f.optionId}\u0000${f.version}\u0000${f.betterBucket}`) &&
      keepBuckets.has(`${f.optionId}\u0000${f.version}\u0000${f.worseBucket}`),
  );

  return { ...report, stats: filtered, stateConditioned: sc };
}

/** Render an experience report as text. `c` is an optional color palette. */
export function formatExperienceReport(report: ExperienceReport, c: ReportColors = {}): string {
  const cols: Required<ReportColors> = {
    bold: c.bold ?? ((s) => s),
    dim: c.dim ?? ((s) => s),
    ok: c.ok ?? ((s) => s),
    warn: c.warn ?? ((s) => s),
  };
  const lines: string[] = [];

  lines.push(cols.bold("Option utility (offline experience report)"));
  lines.push(
    cols.dim(
      `  ${report.events} events  ·  ${report.tasks} tasks  ·  ${report.stats.length} option/state cells  ·  min-samples ${report.minSamples}`,
    ),
  );

  if (report.stats.length === 0) {
    lines.push("");
    lines.push(cols.dim("  No experience events yet. Run traced sessions, then re-run this report."));
    return lines.join("\n");
  }

  lines.push("");
  lines.push(cols.bold("State-conditioned reliability"));
  if (report.stateConditioned.length === 0) {
    lines.push(cols.dim("  (no option shows a confident reliability gap across states yet)"));
  } else {
    for (const f of report.stateConditioned) {
      lines.push(
        `  ${cols.ok(f.optionId + "@" + f.version)} is more reliable in ${cols.bold(f.betterBucket)} (${pct(f.betterRate)}) than ${cols.bold(f.worseBucket)} (${pct(f.worseRate)})`,
      );
    }
  }

  lines.push("");
  lines.push(cols.bold("Per option/state cells"));
  for (const s of report.stats) {
    lines.push(statLine(s, cols));
  }

  return lines.join("\n");
}
