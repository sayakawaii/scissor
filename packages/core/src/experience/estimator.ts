/**
 * E3 "Estimate" stage — transparent execution-scope estimation
 * (Yin & Feng, arXiv:2607.13034, §4.2).
 *
 * Before committing budget, judge how much a task actually needs: its difficulty,
 * the scope of change, the risk, and a confidence in that judgment. This is a
 * cheap, deliberately-imperfect lexical estimator (plus an optional one-probe hit
 * count) — optimistic by design, because the later Expand stage (Phase 3) is the
 * safety net that recovers under-scoped tasks. Pure and deterministic so it is
 * unit-testable and adds no LLM cost.
 *
 * Phase 1 is OBSERVE-ONLY: the operating point is computed and recorded, but does
 * not yet change what context the agent gathers (that is Phase 2 — gate
 * repo-map/retrieval on the estimate). See OPEN_ITEMS §7e.
 */

/** How wide a change the task appears to require. */
export type ScopeLevel = "local" | "cross-file" | "repo";

/** The estimated initial operating point x₀ = (difficulty, scope, risk, confidence). */
export interface OperatingPoint {
  /** 1 = localized single-site edit, 2 = a few files, 3 = repository-wide. */
  difficulty: 1 | 2 | 3;
  scope: ScopeLevel;
  risk: "low" | "medium" | "high";
  /** 0..1; lowered when lexical cues and structure conflict (Expand candidate). */
  confidence: number;
  /** Human-readable cues that drove the estimate, for tracing/advice. */
  rationale: string[];
}

export interface EstimatorInput {
  /** The user request / task prompt. */
  query: string;
  /**
   * Optional: occurrence count of the salient token from ONE cheap probe
   * (e.g. a single search). When a localized-looking task actually hits many
   * sites, confidence is lowered so Expand can recover it.
   */
  probeHits?: number;
}

// Broad-scope cues: wording that advertises a repository-wide change.
const BROAD_SCOPE = [
  /\bacross the (?:code ?base|repo(?:sitory)?|project)\b/i,
  /\b(?:every|all|each) (?:call ?site|callsites|usages?|occurrences?|references?|files?|modules?)\b/i,
  /\beverywhere\b/i,
  /\bthroughout\b/i,
  /\bre-?export\b/i,
  /\brefactor\b/i,
  /\bmigrat(?:e|ion)\b/i,
  /\brename\b[^.]*\b(?:everywhere|all|across|throughout)\b/i,
  /\bcode ?base-wide\b/i,
  /\brroll out\b/i,
];

// Localized verbs: a small, contained change.
const LOCAL_VERB =
  /\b(?:fix|change|update|replace|edit|correct|tweak|adjust|set|bump|rename|remove|delete|add)\b/i;

// Cues that a change is small even without a filename (typo, a constant, etc.).
const LOCAL_NOUN =
  /\b(?:typo|comment|version|constant|value|string|import|default|label|message|log|off-?by-?one|return value)\b/i;

/** A path-like or extensioned token, e.g. `src/foo.ts`, `index.html`, `README`. */
const FILE_REF = /\b[\w./-]*\.(?:[a-z]{1,6}|[A-Z]{1,6})\b|\b[\w-]+\/[\w./-]+\b/;
/** A quoted literal — a `"symbol"`, 'value', or `token`. */
const QUOTED = /(["'`])(?:(?!\1).){1,80}\1/;

function has(re: RegExp, s: string): boolean {
  return re.test(s);
}

/**
 * Estimate the initial operating point for a task from its wording (and, when
 * available, a single structural probe). Optimistic and cheap by design.
 */
export function estimateOperatingPoint(input: EstimatorInput): OperatingPoint {
  const q = input.query ?? "";
  const rationale: string[] = [];

  const broad = BROAD_SCOPE.some((re) => has(re, q));
  const fileRef = has(FILE_REF, q);
  const quoted = has(QUOTED, q);
  const localVerb = has(LOCAL_VERB, q);
  const localNoun = has(LOCAL_NOUN, q);

  let op: OperatingPoint;

  if (broad) {
    rationale.push("broad-scope wording (across the codebase / every call site / refactor)");
    op = { difficulty: 3, scope: "repo", risk: "high", confidence: 0.8, rationale };
  } else if ((fileRef || quoted) && (localVerb || localNoun)) {
    if (fileRef) rationale.push("explicit file/path reference");
    if (quoted) rationale.push("quoted literal to change");
    if (localVerb) rationale.push("localized verb");
    if (localNoun) rationale.push("small-change noun (typo/constant/version/…)");
    op = { difficulty: 1, scope: "local", risk: "low", confidence: 0.8, rationale };
  } else {
    rationale.push("no strong locality or breadth cues — assume a few files");
    op = { difficulty: 2, scope: "cross-file", risk: "medium", confidence: 0.5, rationale };
  }

  // Structural probe conflict: localized phrasing but the salient token appears
  // in many places → lower confidence and flag as an Expand candidate. The paper
  // (§4.2) keeps the optimistic estimate but marks it for recovery.
  if (input.probeHits !== undefined && input.probeHits > 2 && op.difficulty < 3) {
    rationale.push(`probe found ${input.probeHits} hits — wording looks local but footprint is wider`);
    op = { ...op, confidence: Math.min(op.confidence, 0.35) };
  }

  return op;
}

/** One-line human summary of an operating point, for tracing / dim CLI output. */
export function formatOperatingPoint(op: OperatingPoint): string {
  return (
    `scope=${op.scope} difficulty=${op.difficulty} risk=${op.risk} ` +
    `confidence=${op.confidence.toFixed(2)} (${op.rationale.join("; ")})`
  );
}
