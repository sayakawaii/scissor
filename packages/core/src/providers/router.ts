import type {
  ChatParams,
  ChatResult,
  LLMProvider,
  Message,
  ProviderId,
} from "../types.js";

/**
 * A heuristic model router. Each turn is scored for difficulty and sent to the
 * cheaper "cheap" tier by default, escalating to the "strong" tier only when the
 * turn looks hard (complex intent, large context, a long-running turn, or a
 * failed verification on the previous turn). This is a lightweight, transparent
 * version of the "route each turn to the cheapest capable model" idea — no
 * trained model, just explainable signals.
 */

/** Intent keywords (EN + ZH) that signal a harder, reasoning-heavy request. */
export const HARD_KEYWORDS: readonly string[] = [
  "refactor",
  "debug",
  "architecture",
  "architect",
  "design",
  "optimiz", // optimize / optimise / optimization
  "concurren", // concurrency / concurrent
  "race condition",
  "deadlock",
  "security",
  "vulnerab", // vulnerable / vulnerability
  "algorithm",
  "complexity",
  "prove",
  "root cause",
  "why does",
  "why is",
  "trace through",
  "profil", // profile / profiling
  "migrate",
  "redesign",
  // Chinese
  "重构",
  "调试",
  "架构",
  "设计",
  "优化",
  "并发",
  "死锁",
  "安全",
  "漏洞",
  "算法",
  "复杂度",
  "为什么",
  "根因",
  "定位",
  "迁移",
];

/** Weight table for the routing score. Exported so tests/docs stay in sync. */
export const ROUTE_WEIGHTS = {
  complexIntent: 3,
  verifyFailed: 3,
  largeContext: 2,
  mediumContext: 1,
  longTurn: 1,
} as const;

export const DEFAULT_ROUTE_THRESHOLD = 3;

const LARGE_CONTEXT_CHARS = 12_000;
const MEDIUM_CONTEXT_CHARS = 4_000;
const LONG_TURN_ASSISTANT_MSGS = 4;

const VERIFY_PREFIX = "[automated verification]";
const COMPACT_PREFIX = "(Earlier conversation was summarized";

export type RouteTier = "cheap" | "strong";

export interface RouteDecision {
  tier: RouteTier;
  score: number;
  /** Human-readable signals that contributed to the score. */
  reasons: string[];
}

export interface RouteInput {
  messages: Message[];
  threshold: number;
  escalateOnVerifyFail: boolean;
}

function messagesChars(messages: Message[]): number {
  return messages.reduce(
    (n, m) =>
      n + m.content.length + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0),
    0,
  );
}

/** Latest genuine user request, ignoring verification/compaction system nudges. */
function latestUserRequest(messages: Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (
      m.role === "user" &&
      !m.content.startsWith(VERIFY_PREFIX) &&
      !m.content.startsWith(COMPACT_PREFIX)
    ) {
      return m;
    }
  }
  return undefined;
}

/** Pure, testable routing decision for a single turn. */
export function routeTurn(input: RouteInput): RouteDecision {
  const reasons: string[] = [];
  let score = 0;

  // Escalate hard when the previous turn's automated verification failed: the
  // cheap tier already produced something that didn't pass.
  if (input.escalateOnVerifyFail) {
    const recent = input.messages.slice(-3);
    if (recent.some((m) => m.role === "user" && m.content.startsWith(VERIFY_PREFIX))) {
      score += ROUTE_WEIGHTS.verifyFailed;
      reasons.push("verify-failed");
    }
  }

  const lastUser = latestUserRequest(input.messages);
  if (lastUser) {
    const text = lastUser.content.toLowerCase();
    if (HARD_KEYWORDS.some((k) => text.includes(k))) {
      score += ROUTE_WEIGHTS.complexIntent;
      reasons.push("complex-intent");
    }
  }

  const chars = messagesChars(input.messages);
  if (chars > LARGE_CONTEXT_CHARS) {
    score += ROUTE_WEIGHTS.largeContext;
    reasons.push("large-context");
  } else if (chars > MEDIUM_CONTEXT_CHARS) {
    score += ROUTE_WEIGHTS.mediumContext;
    reasons.push("medium-context");
  }

  const assistantTurns = input.messages.filter((m) => m.role === "assistant").length;
  if (assistantTurns >= LONG_TURN_ASSISTANT_MSGS) {
    score += ROUTE_WEIGHTS.longTurn;
    reasons.push("long-turn");
  }

  const tier: RouteTier = score >= input.threshold ? "strong" : "cheap";
  return { tier, score, reasons };
}

/** A concrete tier: an underlying provider plus a display label. */
export interface RouterTier {
  provider: LLMProvider;
  /** e.g. "deepseek:deepseek-chat" */
  label: string;
}

export interface RouterProviderOptions {
  cheap: RouterTier;
  strong: RouterTier;
  /** Score at/above which a turn routes to the strong tier. */
  threshold?: number;
  /** Escalate to strong after a failed verification (default true). */
  escalateOnVerifyFail?: boolean;
  /** Notified with each routing decision (for HUD/logging). */
  onRoute?: (decision: RouteDecision & { tierLabel: string; model: string }) => void;
}

/**
 * LLMProvider that dispatches each turn to a cheap or strong tier based on
 * routeTurn(). Because it is just an LLMProvider, the agent loop, eval harness,
 * and everything else use it unchanged.
 */
export class RouterProvider implements LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  private cheap: RouterTier;
  private strong: RouterTier;
  private threshold: number;
  private escalateOnVerifyFail: boolean;
  private onRoute?: RouterProviderOptions["onRoute"];

  constructor(opts: RouterProviderOptions) {
    this.cheap = opts.cheap;
    this.strong = opts.strong;
    this.threshold = opts.threshold ?? DEFAULT_ROUTE_THRESHOLD;
    this.escalateOnVerifyFail = opts.escalateOnVerifyFail ?? true;
    this.onRoute = opts.onRoute;
    this.id = opts.cheap.provider.id;
    this.model = `router(${opts.cheap.label} | ${opts.strong.label})`;
  }

  async chat(params: ChatParams): Promise<ChatResult> {
    const decision = routeTurn({
      messages: params.messages,
      threshold: this.threshold,
      escalateOnVerifyFail: this.escalateOnVerifyFail,
    });
    const chosen = decision.tier === "strong" ? this.strong : this.cheap;
    this.onRoute?.({ ...decision, tierLabel: chosen.label, model: chosen.provider.model });
    return chosen.provider.chat(params);
  }
}
