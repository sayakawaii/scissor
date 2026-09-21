import type { Message, ProviderId } from "./types.js";

/**
 * Token estimation seam.
 *
 * Context budgets were counted in characters, which is the wrong unit: what the
 * provider actually charges and truncates on is tokens, and the characters-per-
 * token ratio differs by several tens of percent across model families. A budget
 * tuned in characters is therefore either wasteful or over-limit depending on
 * which model is answering.
 *
 * This is deliberately a *seam*, not a tokenizer. The estimate is a per-family
 * ratio, which is accurate enough to budget with and costs nothing; the point is
 * that every budget in the loop is now expressed in tokens, so dropping in a
 * real tokenizer later is a change to this file alone.
 */

/**
 * Characters per token by model family, taken as conservative (low) values so
 * an estimate errs toward *over*-counting tokens and the budget is not blown.
 * Code and JSON — most of what a coding agent sends — tokenize worse than prose,
 * which these already account for.
 */
const CHARS_PER_TOKEN: Record<ProviderId, number> = {
  claude: 3.4,
  gpt: 3.6,
  deepseek: 3.4,
  glm: 3.0,
  nebius: 3.4,
};

/** Used when the provider is unknown. */
const DEFAULT_CHARS_PER_TOKEN = 3.4;

/**
 * Per-message overhead in tokens: role markers, message delimiters, and the
 * scaffolding a provider wraps around each message on the wire.
 */
const MESSAGE_OVERHEAD_TOKENS = 4;

export function charsPerToken(provider?: ProviderId): number {
  return provider ? CHARS_PER_TOKEN[provider] : DEFAULT_CHARS_PER_TOKEN;
}

/** Estimated token count of a string. */
export function estimateTokens(text: string, provider?: ProviderId): number {
  if (!text) return 0;
  return Math.ceil(text.length / charsPerToken(provider));
}

/** Characters that fit in a token budget — the inverse of estimateTokens. */
export function tokensToChars(tokens: number, provider?: ProviderId): number {
  return Math.max(0, Math.floor(tokens * charsPerToken(provider)));
}

/** Convert a character budget to the equivalent token budget. */
export function charsToTokens(chars: number, provider?: ProviderId): number {
  return Math.max(0, Math.ceil(chars / charsPerToken(provider)));
}

/** Estimated tokens for one message, including its tool calls and overhead. */
export function estimateMessageTokens(m: Message, provider?: ProviderId): number {
  const calls = m.toolCalls ? JSON.stringify(m.toolCalls) : "";
  return (
    MESSAGE_OVERHEAD_TOKENS +
    estimateTokens(m.content, provider) +
    estimateTokens(calls, provider)
  );
}

/** Estimated tokens for a whole conversation. */
export function estimateConversationTokens(
  messages: readonly Message[],
  provider?: ProviderId,
): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m, provider);
  return total;
}

/**
 * How a budget is measured and spent. Truncation needs both directions: the cost
 * of a string, and how many characters a granted budget buys back.
 */
export interface BudgetMeasure {
  cost(text: string): number;
  charsFor(units: number): number;
}

/** Measure a budget in estimated tokens for a given provider. */
export function tokenMeasure(provider?: ProviderId): BudgetMeasure {
  return {
    cost: (text) => estimateTokens(text, provider),
    charsFor: (units) => tokensToChars(units, provider),
  };
}

/** Measure a budget in raw characters. */
export const charMeasure: BudgetMeasure = {
  cost: (text) => text.length,
  charsFor: (units) => Math.max(0, Math.floor(units)),
};
