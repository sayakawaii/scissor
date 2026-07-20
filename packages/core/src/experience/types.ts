/**
 * OaK-inspired experience layer — shared data model (UI-agnostic).
 *
 * This is the "minimal data model" from docs/agent-design/oak-inspired-agent-design.md §6:
 * a normalized `(state, option, outcome)` record derived from real execution
 * traces. The engine only defines and aggregates these structures; how they are
 * emitted and read from disk is a UI/CLI concern (JSONL traces live there).
 *
 * Design constraints (doc §6, §7):
 *  - State features must be LOW-CARDINALITY, STABLE, and SECRET-FREE. Free text
 *    is only ever kept as a normalized/hashed error signature.
 *  - Statistics are isolated per option `version` so model/prompt/tool drift
 *    does not silently poison an option's history (doc §3.4, §7 non-stationarity).
 *  - This layer is OBSERVE-ONLY: it never influences agent decisions. Aggregation
 *    is deterministic given the same input so it is trivially testable.
 */

/** Current schema version for a normalized experience event. */
export const EXPERIENCE_SCHEMA_VERSION = 1 as const;

/** Why an option stopped. Distinguishing these is essential (doc §7 "数据污染"):
 * a user cancel, budget exhaustion, or a guardrail veto is NOT an option's own
 * capability failure and must not be counted as one. */
export type ExperienceTermination =
  | "success"
  | "failure"
  | "cancelled"
  | "budget"
  | "guardrail";

/** Final task-level outcome, used to weight whether an option actually helped
 * the PRIMARY objective rather than just a local subtask (doc §7). */
export type FinalTaskOutcome = "success" | "failure" | "unknown";

/** Identifies an option (tool / skill / subagent / control tool) and its version. */
export interface OptionRef {
  id: string;
  version: string;
}

/** Evidence backing the recorded outcome — real results, not model text (doc §2.3). */
export interface ExperienceEvidence {
  /** Whether project verification (typecheck/build/test/lint) passed after this. */
  verificationPassed?: boolean;
  /** Normalized, secret-free failure signature (see features.ts). */
  errorSignature?: string;
  /** Number of files this option changed. */
  changedFiles?: number;
}

/** Token / money cost attributed to an option occurrence. */
export interface ExperienceCost {
  inputTokens?: number;
  outputTokens?: number;
  usd?: number;
}

/**
 * A single normalized experience event: one option occurrence in a known state
 * with a verified outcome. Mirrors the doc §6 data model exactly.
 */
export interface ExperienceEvent {
  schemaVersion: typeof EXPERIENCE_SCHEMA_VERSION;
  /** Correlates events from the same run/task (e.g. the session id). */
  taskId: string;
  option: OptionRef;
  /** Low-cardinality, secret-free state features. */
  state: Record<string, string | number | boolean>;
  /** ISO timestamp the option started. */
  startedAt: string;
  durationMs: number;
  termination: ExperienceTermination;
  evidence: ExperienceEvidence;
  cost: ExperienceCost;
  finalTaskOutcome?: FinalTaskOutcome;
}

/** A counted error signature within a bucket. */
export interface ErrorSignatureCount {
  signature: string;
  count: number;
}

/**
 * Aggregated utility for one `(stateBucket, option, version)` cell. Success rate
 * is a Beta/Bernoulli estimate; the Wilson interval and sample count make the
 * confidence explicit so a thin sample is never mistaken for signal (doc §3.4).
 */
export interface OptionStat {
  optionId: string;
  version: string;
  /** Stable key describing the state the option ran in (see deriveStateBucket). */
  stateBucket: string;
  /** Total occurrences counted toward capability success/failure. */
  samples: number;
  /** `success` terminations. */
  successes: number;
  /** `failure` terminations (genuine capability failures only). */
  failures: number;
  /** Occurrences excluded from the success rate (cancelled/budget/guardrail). */
  excluded: number;
  /** Point estimate of success probability over counted samples. */
  successRate: number;
  /** Wilson score interval (95%) lower/upper bounds over counted samples. */
  ciLow: number;
  ciHigh: number;
  /** True once `samples >= minSamples` — below this the estimate is untrusted. */
  confident: boolean;
  /** Exponentially-decayed mean duration (ms) over counted samples. */
  meanDurationMs: number;
  /** Exponentially-decayed mean USD cost over counted samples (0 if unpriced). */
  meanUsd: number;
  /** How many counted samples had verification evidence that passed. */
  verificationPassed: number;
  /** Counted samples whose final task outcome was known (success or failure). */
  finalKnownSamples: number;
  /** Fraction of finalKnownSamples that contributed to a successful final task. */
  finalSuccessRate: number;
  /** Top failure signatures observed in this bucket, most frequent first. */
  topErrors: ErrorSignatureCount[];
}

/** Options that are meaningfully more reliable in one state bucket than another. */
export interface StateConditionedFinding {
  optionId: string;
  version: string;
  betterBucket: string;
  worseBucket: string;
  betterRate: number;
  worseRate: number;
}

/** Full offline report over a set of experience events. */
export interface ExperienceReport {
  schemaVersion: typeof EXPERIENCE_SCHEMA_VERSION;
  /** Number of events considered (after schema filtering). */
  events: number;
  /** Distinct task ids observed. */
  tasks: number;
  /** Minimum sample threshold used to flag `confident` stats. */
  minSamples: number;
  /** Per-cell option statistics, sorted for stable, readable output. */
  stats: OptionStat[];
  /** Options that are clearly more reliable in one state than another (doc §8.5). */
  stateConditioned: StateConditionedFinding[];
}
