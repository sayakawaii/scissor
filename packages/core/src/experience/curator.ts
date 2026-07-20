/**
 * OaK-inspired experience layer — Utility Curator (doc §3.6, §5 Phase 5).
 *
 * Reviews the offline experience report and emits CURATION SUGGESTIONS for each
 * confident option/state cell — keep, promote, demote, archive, investigate, or
 * disable. Crucially (doc §3.6, §5, §9):
 *
 *  - It only SUGGESTS. Nothing is applied automatically; a human confirms before
 *    any capability, memory, permission, or hard constraint changes.
 *  - Utility is judged by contribution to the FINAL task outcome and reliability,
 *    never by call count (doc §9).
 *  - Suggestions require confidence (enough samples) and are isolated per version
 *    so drift/thin data can't drive a change.
 *
 * "Merge redundant capabilities" (doc §3.6) is intentionally NOT inferred here:
 * functional redundancy cannot be derived from success statistics alone — it
 * needs an Option Registry with capability metadata (doc §3.3), which is future
 * work. Emitting merges from co-reliability would be unsound.
 */
import type { ExperienceReport, ErrorSignatureCount, OptionStat } from "./types.js";

export type CurationAction =
  | "disable"
  | "investigate"
  | "archive"
  | "demote"
  | "promote"
  | "keep";

export interface CurationRecommendation {
  action: CurationAction;
  optionId: string;
  version: string;
  stateBucket: string;
  samples: number;
  successRate: number;
  finalKnownSamples: number;
  finalSuccessRate: number;
  topError?: ErrorSignatureCount;
  /** Human-readable justification grounded in the statistics. */
  reason: string;
}

export interface CurateOptions {
  /** Override the confidence threshold (default: report.minSamples). */
  minSamples?: number;
  /** At/below this success rate an option is a disable candidate (default 0.25). */
  disableAt?: number;
  /** Below this success rate an option is unreliable (default 0.5). */
  unreliableAt?: number;
  /** At/above this success rate an option is reliable (default 0.8). */
  reliableAt?: number;
  /** Min known final outcomes before contribution is judged (default: minSamples). */
  minFinalSamples?: number;
}

export const DEFAULT_DISABLE_AT = 0.25;
export const DEFAULT_UNRELIABLE_AT = 0.5;
export const DEFAULT_RELIABLE_AT = 0.8;

const SEVERITY: Record<CurationAction, number> = {
  disable: 0,
  investigate: 1,
  archive: 2,
  demote: 3,
  promote: 4,
  keep: 5,
};

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function classify(s: OptionStat, o: Required<CurateOptions>): CurationRecommendation {
  const base = {
    optionId: s.optionId,
    version: s.version,
    stateBucket: s.stateBucket,
    samples: s.samples,
    successRate: s.successRate,
    finalKnownSamples: s.finalKnownSamples,
    finalSuccessRate: s.finalSuccessRate,
    ...(s.topErrors[0] ? { topError: s.topErrors[0] } : {}),
  };
  const counts = `${s.successes}/${s.samples}`;

  // Unreliable options: disable (severe) or investigate.
  if (s.successRate <= o.disableAt) {
    const err = s.topErrors[0] ? `; common failure "${s.topErrors[0].signature}"` : "";
    return {
      ...base,
      action: "disable",
      reason: `consistently fails here (${counts}, ${pct(s.successRate)}${err}) — disable/avoid in this state or fix the cause`,
    };
  }
  if (s.successRate < o.unreliableAt) {
    return {
      ...base,
      action: "investigate",
      reason: `unreliable here (${counts}, ${pct(s.successRate)}) — investigate before relying on it`,
    };
  }

  // Reliable options: judge contribution to final task success when known.
  const finalKnown = s.finalKnownSamples >= o.minFinalSamples;
  if (s.successRate >= o.reliableAt) {
    if (finalKnown && s.finalSuccessRate === 0) {
      return {
        ...base,
        action: "archive",
        reason: `reliable locally (${counts}) but NEVER part of a successful task (0/${s.finalKnownSamples}) — archive candidate`,
      };
    }
    if (finalKnown && s.finalSuccessRate < o.unreliableAt) {
      return {
        ...base,
        action: "demote",
        reason: `reliable locally (${counts}) but weak contribution to task success (${pct(s.finalSuccessRate)}) — demote priority`,
      };
    }
    if (finalKnown && s.finalSuccessRate >= o.reliableAt) {
      return {
        ...base,
        action: "promote",
        reason: `reliable (${counts}) and strongly tied to task success (${pct(s.finalSuccessRate)}) — promote/keep`,
      };
    }
  }

  return {
    ...base,
    action: "keep",
    reason: `acceptable here (${counts}, ${pct(s.successRate)}) — keep`,
  };
}

/**
 * Produce curation suggestions for every CONFIDENT option/state cell. Sorted by
 * severity (most actionable first), then by option and state for stability.
 * Read-only: callers must present these for human review, not apply them.
 */
export function curateOptions(
  report: ExperienceReport,
  opts: CurateOptions = {},
): CurationRecommendation[] {
  const o: Required<CurateOptions> = {
    minSamples: opts.minSamples ?? report.minSamples,
    disableAt: opts.disableAt ?? DEFAULT_DISABLE_AT,
    unreliableAt: opts.unreliableAt ?? DEFAULT_UNRELIABLE_AT,
    reliableAt: opts.reliableAt ?? DEFAULT_RELIABLE_AT,
    minFinalSamples: opts.minFinalSamples ?? (opts.minSamples ?? report.minSamples),
  };

  const recs = report.stats
    .filter((s) => s.confident && s.samples >= o.minSamples)
    .map((s) => classify(s, o));

  recs.sort(
    (a, b) =>
      SEVERITY[a.action] - SEVERITY[b.action] ||
      (a.optionId < b.optionId ? -1 : a.optionId > b.optionId ? 1 : 0) ||
      (a.stateBucket < b.stateBucket ? -1 : a.stateBucket > b.stateBucket ? 1 : 0),
  );
  return recs;
}

export interface CurationColors {
  bold?: (s: string) => string;
  dim?: (s: string) => string;
  ok?: (s: string) => string;
  warn?: (s: string) => string;
  err?: (s: string) => string;
}

/** Render curation suggestions for the terminal. */
export function formatCuration(
  recs: CurationRecommendation[],
  c: CurationColors = {},
): string {
  const bold = c.bold ?? ((s: string) => s);
  const dim = c.dim ?? ((s: string) => s);
  const ok = c.ok ?? ((s: string) => s);
  const warn = c.warn ?? ((s: string) => s);
  const err = c.err ?? ((s: string) => s);

  const lines: string[] = [];
  lines.push(bold("Capability curation (SUGGESTIONS ONLY)"));
  lines.push(
    dim("  Nothing is changed automatically. Review and apply manually; permissions and hard constraints are never touched."),
  );
  if (recs.length === 0) {
    lines.push("");
    lines.push(dim("  No confident cells to curate yet — run more traced sessions."));
    return lines.join("\n");
  }

  const paint = (a: CurationAction, s: string): string =>
    a === "disable"
      ? err(s)
      : a === "investigate" || a === "archive" || a === "demote"
        ? warn(s)
        : ok(s);

  lines.push("");
  for (const r of recs) {
    lines.push(`  ${paint(r.action, r.action.toUpperCase().padEnd(11))} ${bold(r.optionId)}  ${dim(`state=${r.stateBucket}`)}`);
    lines.push(`      ${dim(r.reason)}`);
  }
  return lines.join("\n");
}
