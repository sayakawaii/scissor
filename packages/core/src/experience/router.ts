/**
 * OaK-inspired experience layer — restricted auto-router (doc §5 Phase 4 受限自动路由).
 *
 * Turns learned option reliability into an ACTION, but under strict safety
 * controls demanded by the doc (§5 Phase 4, §7 过早自动化):
 *
 *  - feature flag: the router only exists when a mode is chosen (never on by
 *    default); `off` is a hard no-op.
 *  - shadow-first: `shadow` mode records the route it WOULD take but never
 *    overrides the agent — this is the "shadow evaluation" the doc requires
 *    before any enforcement.
 *  - allowlist only: it acts solely on explicit low-risk, reversible `from->to`
 *    rules; with no rules it can never route anything.
 *  - per-option kill switch: any option id can be excluded outright.
 *  - confidence threshold: both cells must be confident (>= minSamples).
 *  - drift isolation: stats are scoped to the current option `version` (model),
 *    per the doc's non-stationarity guidance (§7).
 *  - fallback: any uncertainty returns `allow` — the existing policy decides.
 *
 * Even in `enforce` mode a route is a reversible deflection (a non-error message
 * steering the agent to a better option), never a destructive action. Mutating
 * tools are out of scope by construction (rules should only list reversible,
 * interchangeable options such as read-only retrieval tools).
 */
import type { Guardrail, ToolCall } from "../types.js";
import { deriveStateBucket } from "./features.js";
import type { ExperienceReport, OptionStat } from "./types.js";

export type RouterMode = "off" | "shadow" | "enforce";

/** An allowlisted low-risk, reversible route: prefer `to` over `from`. */
export interface RoutingRule {
  from: string;
  to: string;
}

export interface ExperienceRouterConfig {
  mode: RouterMode;
  /** Allowlisted routes. Empty => the router never acts (safe default). */
  rules: RoutingRule[];
  /** Per-option kill switch: option ids that must never be routed. */
  killSwitch?: string[];
  /** Minimum samples for a cell to be trusted (confidence threshold). */
  minSamples?: number;
  /** Required success-rate advantage of `to` over `from` before routing. */
  gap?: number;
  /** Only route when `from`'s success rate is at/below this (looks unreliable). */
  maxFromRate?: number;
  /** Scope stats to this option version (session model) for drift isolation. */
  version?: string;
}

export interface RouteContext {
  report: ExperienceReport;
  state?: Record<string, string | number | boolean>;
  config: ExperienceRouterConfig;
}

export type RouteAction = "allow" | "deflect";

export interface RouteVerdict {
  action: RouteAction;
  from: string;
  to?: string;
  /** Why this decision was made (for observability / trace). */
  reason: string;
  fromRate?: number;
  toRate?: number;
  fromSamples?: number;
  toSamples?: number;
  stateBucket?: string;
}

export const DEFAULT_ROUTE_GAP = 0.25;
export const DEFAULT_ROUTE_MAX_FROM_RATE = 0.6;

function allow(from: string, reason: string, stateBucket?: string): RouteVerdict {
  return { action: "allow", from, reason, stateBucket };
}

/** Pick the most-sampled cell for an option in a state bucket (and version). */
function pickCell(
  report: ExperienceReport,
  id: string,
  bucket: string,
  version?: string,
): OptionStat | undefined {
  const matches = report.stats.filter(
    (s) => s.optionId === id && s.stateBucket === bucket && (version === undefined || s.version === version),
  );
  if (matches.length === 0) return undefined;
  return matches.reduce((a, b) => (b.samples > a.samples ? b : a));
}

/**
 * Decide whether to route a tool call to a more reliable alternative. Pure and
 * deterministic; every failure/uncertainty path returns `allow` (fallback to the
 * existing policy). See the module doc for the safety controls applied here.
 */
export function decideRoute(call: ToolCall, ctx: RouteContext): RouteVerdict {
  const from = call.name;
  const { config, report } = ctx;

  if (config.mode === "off") return allow(from, "router off");

  const rule = config.rules.find((r) => r.from === from);
  if (!rule) return allow(from, "no matching route rule");

  if (config.killSwitch?.includes(from)) return allow(from, `kill-switch: ${from}`);

  const bucket = deriveStateBucket(ctx.state);
  const minSamples = config.minSamples ?? report.minSamples;
  const gap = config.gap ?? DEFAULT_ROUTE_GAP;
  const maxFromRate = config.maxFromRate ?? DEFAULT_ROUTE_MAX_FROM_RATE;

  const fromStat = pickCell(report, rule.from, bucket, config.version);
  const toStat = pickCell(report, rule.to, bucket, config.version);
  if (!fromStat || !toStat) return allow(from, "insufficient data for from/to", bucket);

  // Confidence threshold + drift isolation (version already applied above).
  if (
    !fromStat.confident ||
    !toStat.confident ||
    fromStat.samples < minSamples ||
    toStat.samples < minSamples
  ) {
    return allow(from, "insufficient confidence — fallback", bucket);
  }

  if (fromStat.successRate > maxFromRate) {
    return allow(from, "from not unreliable enough", bucket);
  }

  if (toStat.successRate - fromStat.successRate < gap) {
    return allow(from, "reliability gap below threshold", bucket);
  }

  return {
    action: "deflect",
    from: rule.from,
    to: rule.to,
    reason: `experience: ${rule.from} unreliable here, ${rule.to} more reliable`,
    fromRate: fromStat.successRate,
    toRate: toStat.successRate,
    fromSamples: fromStat.samples,
    toSamples: toStat.samples,
    stateBucket: bucket,
  };
}

export interface RouterGuardHooks {
  /** Called for each deflect decision (shadow or enforce) so the UI can trace it. */
  onDecision?: (decision: RouteVerdict) => void;
}

/**
 * Guardrail wrapping the routing policy. In `shadow` mode it records the route
 * it would take but always allows; in `enforce` mode it deflects with a
 * reversible, non-error message so the agent re-decides. Never blocks in `off`.
 */
export function createExperienceRouterGuard(
  ctx: RouteContext,
  hooks: RouterGuardHooks = {},
): Guardrail {
  return {
    name: "experience-router",
    beforeTool(call: ToolCall) {
      if (ctx.config.mode === "off") return { allow: true };
      const decision = decideRoute(call, ctx);
      if (decision.action !== "deflect") return { allow: true };

      hooks.onDecision?.(decision);

      if (ctx.config.mode !== "enforce") return { allow: true }; // shadow: observe only

      const pctFrom = Math.round((decision.fromRate ?? 0) * 100);
      return {
        allow: false,
        reason: `experience-route ${decision.from}->${decision.to}`,
        result: {
          content:
            `Experience routing: "${decision.from}" has been unreliable in this workspace state ` +
            `(${decision.fromSamples ?? 0} samples, ~${pctFrom}% success). Prefer "${decision.to}" ` +
            `instead. Not running "${decision.from}" now — use "${decision.to}" or another approach.`,
          // Non-error, like a rejection: steer without marking a hard failure.
          isError: false,
        },
      };
    },
  };
}
