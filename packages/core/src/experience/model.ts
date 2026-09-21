/**
 * OaK-inspired experience layer — Experience Model (doc §3.4).
 *
 * Offline, deterministic aggregation of normalized `(state, option, outcome)`
 * events into per-cell option utility. Deliberately NOT a neural net or online
 * learner (doc §9): it is explainable bucket statistics — Beta/Bernoulli success
 * rate with a Wilson confidence interval, a minimum-sample threshold, and
 * exponentially-decayed cost/latency means. Statistics are isolated per option
 * `version` and per state bucket so drift and context both stay honest.
 *
 * This module never touches the agent loop; it only reads events and returns a
 * report (doc §8: observe → report, no online decisions in this slice).
 */
import {
  EXPERIENCE_SCHEMA_VERSION,
  type ErrorSignatureCount,
  type ExperienceEvent,
  type ExperienceReport,
  type OptionStat,
  type StateConditionedFinding,
} from "./types.js";
import { deriveStateBucket } from "./features.js";

export interface AggregateOptions {
  /** Below this many counted samples, a stat is flagged `confident: false`. */
  minSamples?: number;
  /**
   * EWMA weight for the newest sample when averaging duration/cost. Higher =
   * more responsive to recent runs (doc §3.4 time-decay). Range (0, 1].
   */
  decayAlpha?: number;
  /**
   * Minimum success-rate gap between two buckets (both confident) for an option
   * to be reported as state-conditioned (doc §8.5).
   */
  stateGap?: number;
}

export const DEFAULT_MIN_SAMPLES = 5;
export const DEFAULT_DECAY_ALPHA = 0.4;
export const DEFAULT_STATE_GAP = 0.25;

/** Wilson score interval (95%, z=1.96) for a Bernoulli proportion. */
export function wilsonInterval(successes: number, n: number): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 0 };
  const z = 1.96;
  const z2 = z * z;
  const p = successes / n;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

interface Accumulator {
  optionId: string;
  version: string;
  stateBucket: string;
  successes: number;
  failures: number;
  excluded: number;
  verificationPassed: number;
  finalSuccesses: number;
  finalKnown: number;
  meanDurationMs: number;
  meanUsd: number;
  seenCounted: boolean;
  errors: Map<string, number>;
}

function cellKey(bucket: string, id: string, version: string): string {
  return `${bucket}\u0000${id}\u0000${version}`;
}

/** True for terminations that reflect the option's own capability outcome. */
function countsTowardSuccess(t: ExperienceEvent["termination"]): boolean {
  return t === "success" || t === "failure";
}

function topErrors(errors: Map<string, number>, limit = 3): ErrorSignatureCount[] {
  return [...errors.entries()]
    .map(([signature, count]) => ({ signature, count }))
    .sort((a, b) => (b.count - a.count) || (a.signature < b.signature ? -1 : 1))
    .slice(0, limit);
}

/**
 * Aggregate normalized experience events into an offline utility report.
 * Deterministic: events are sorted by (startedAt, taskId) before EWMA so decayed
 * means do not depend on input ordering.
 */
export function aggregateExperience(
  input: ExperienceEvent[],
  opts: AggregateOptions = {},
): ExperienceReport {
  const minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES;
  const alpha = opts.decayAlpha ?? DEFAULT_DECAY_ALPHA;
  const stateGap = opts.stateGap ?? DEFAULT_STATE_GAP;

  const events = input.filter((e) => e && e.schemaVersion === EXPERIENCE_SCHEMA_VERSION);

  // Stable chronological order so EWMA is order-independent of the input array.
  const ordered = [...events].sort((a, b) => {
    if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? -1 : 1;
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  });

  const cells = new Map<string, Accumulator>();
  const tasks = new Set<string>();

  for (const e of ordered) {
    tasks.add(e.taskId);
    const bucket = deriveStateBucket(e.state);
    const key = cellKey(bucket, e.option.id, e.option.version);
    let acc = cells.get(key);
    if (!acc) {
      acc = {
        optionId: e.option.id,
        version: e.option.version,
        stateBucket: bucket,
        successes: 0,
        failures: 0,
        excluded: 0,
        verificationPassed: 0,
        finalSuccesses: 0,
        finalKnown: 0,
        meanDurationMs: 0,
        meanUsd: 0,
        seenCounted: false,
        errors: new Map(),
      };
      cells.set(key, acc);
    }

    if (!countsTowardSuccess(e.termination)) {
      acc.excluded++;
      continue;
    }

    // Counted sample: update success/failure, EWMA cost/latency, evidence.
    if (e.termination === "success") acc.successes++;
    else acc.failures++;

    const dur = Number.isFinite(e.durationMs) ? Math.max(0, e.durationMs) : 0;
    const usd = Number.isFinite(e.cost?.usd ?? NaN) ? Math.max(0, e.cost!.usd!) : 0;
    if (!acc.seenCounted) {
      acc.meanDurationMs = dur;
      acc.meanUsd = usd;
      acc.seenCounted = true;
    } else {
      acc.meanDurationMs = alpha * dur + (1 - alpha) * acc.meanDurationMs;
      acc.meanUsd = alpha * usd + (1 - alpha) * acc.meanUsd;
    }

    if (e.evidence?.verificationPassed === true) acc.verificationPassed++;
    if (e.finalTaskOutcome === "success" || e.finalTaskOutcome === "failure") {
      acc.finalKnown++;
      if (e.finalTaskOutcome === "success") acc.finalSuccesses++;
    }
    const sig = e.evidence?.errorSignature;
    if (e.termination === "failure" && sig) {
      acc.errors.set(sig, (acc.errors.get(sig) ?? 0) + 1);
    }
  }

  const stats: OptionStat[] = [...cells.values()].map((acc) => {
    const samples = acc.successes + acc.failures;
    const successRate = samples > 0 ? acc.successes / samples : 0;
    const ci = wilsonInterval(acc.successes, samples);
    return {
      optionId: acc.optionId,
      version: acc.version,
      stateBucket: acc.stateBucket,
      samples,
      successes: acc.successes,
      failures: acc.failures,
      excluded: acc.excluded,
      successRate,
      ciLow: ci.low,
      ciHigh: ci.high,
      confident: samples >= minSamples,
      meanDurationMs: acc.meanDurationMs,
      meanUsd: acc.meanUsd,
      verificationPassed: acc.verificationPassed,
      finalKnownSamples: acc.finalKnown,
      finalSuccessRate: acc.finalKnown > 0 ? acc.finalSuccesses / acc.finalKnown : 0,
      topErrors: topErrors(acc.errors),
    };
  });

  // Stable sort: option id, then version, then most-sampled bucket first.
  stats.sort(
    (a, b) =>
      (a.optionId < b.optionId ? -1 : a.optionId > b.optionId ? 1 : 0) ||
      (a.version < b.version ? -1 : a.version > b.version ? 1 : 0) ||
      b.samples - a.samples ||
      (a.stateBucket < b.stateBucket ? -1 : a.stateBucket > b.stateBucket ? 1 : 0),
  );

  return {
    schemaVersion: EXPERIENCE_SCHEMA_VERSION,
    events: events.length,
    tasks: tasks.size,
    minSamples,
    stats,
    stateConditioned: findStateConditioned(stats, stateGap),
  };
}

/**
 * Detect options that are clearly more reliable in one state bucket than in
 * another (doc §8.5). Only compares buckets where BOTH are `confident`, so a
 * thin sample never fabricates a finding. Returns the widest gap per option.
 */
export function findStateConditioned(
  stats: OptionStat[],
  stateGap: number,
): StateConditionedFinding[] {
  const byOption = new Map<string, OptionStat[]>();
  for (const s of stats) {
    if (!s.confident) continue;
    const key = `${s.optionId}\u0000${s.version}`;
    const list = byOption.get(key);
    if (list) list.push(s);
    else byOption.set(key, [s]);
  }

  const findings: StateConditionedFinding[] = [];
  for (const list of byOption.values()) {
    if (list.length < 2) continue;
    let best = list[0]!;
    let worst = list[0]!;
    for (const s of list) {
      if (s.successRate > best.successRate) best = s;
      if (s.successRate < worst.successRate) worst = s;
    }
    if (best.stateBucket === worst.stateBucket) continue;
    if (best.successRate - worst.successRate < stateGap) continue;
    findings.push({
      optionId: best.optionId,
      version: best.version,
      betterBucket: best.stateBucket,
      worseBucket: worst.stateBucket,
      betterRate: best.successRate,
      worseRate: worst.successRate,
    });
  }

  findings.sort(
    (a, b) =>
      b.betterRate - b.worseRate - (a.betterRate - a.worseRate) ||
      (a.optionId < b.optionId ? -1 : a.optionId > b.optionId ? 1 : 0),
  );
  return findings;
}
