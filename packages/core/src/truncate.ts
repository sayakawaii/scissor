import { charMeasure, type BudgetMeasure } from "./tokens.js";
import type { Message } from "./types.js";

/**
 * Size-driven context reduction: the hard fallback used when the conversation
 * still exceeds its budget after (or without) LLM compaction.
 *
 * The old fallback dropped the oldest complete round, which is a blunt trade:
 * one bloated tool result from twenty rounds ago costs an entire exchange —
 * the user's request, the assistant's reasoning, and every other result in that
 * round — even though shrinking that single message would have been enough.
 *
 * Instead, every eligible message gets a max-min *fair share* of the budget:
 * small messages are kept whole, and the slack they leave over is redistributed
 * to the large ones, so the pressure lands on whatever is actually big. Messages
 * whose share is too small to carry meaning are replaced by a placeholder that
 * records what was there, and the reduction is announced so the model knows it
 * is looking at an abridged history rather than the whole story.
 */

/** Below this many characters a slice is noise, so the message is elided whole. */
export const MIN_USEFUL_CHARS = 200;

/** User messages carry the request, so they are the last thing worth eliding. */
export const MIN_USEFUL_USER_CHARS = 400;

const ELISION = "\n[... truncated ...]\n";

/** Fraction of a truncated message's budget given to its head. */
const HEAD_SHARE = 0.6;

/**
 * Max-min fair allocation: hand each item the smaller of what it asked for and
 * an equal share of what is left, processing smallest-first so the slack from
 * items that fit rolls forward into the share available to the larger ones.
 * Returns allocations in the same order as `sizes`, always summing to at most
 * `totalBudget`.
 */
export function computeMaxMinFairAllocations(
  sizes: readonly number[],
  totalBudget: number,
): number[] {
  const allocations = new Array<number>(sizes.length).fill(0);
  if (sizes.length === 0) return allocations;
  if (totalBudget <= 0) return allocations;

  const order = sizes.map((size, index) => ({ size, index }));
  order.sort((a, b) => a.size - b.size);

  let remainingBudget = totalBudget;
  let remainingItems = order.length;
  for (const { size, index } of order) {
    const fairShare = Math.floor(remainingBudget / remainingItems);
    const granted = Math.min(size, Math.max(0, fairShare));
    allocations[index] = granted;
    remainingBudget -= granted;
    remainingItems -= 1;
  }
  return allocations;
}

/**
 * Shrink text to `budget` characters, keeping its head and its tail with an
 * explicit marker between them. Which end matters depends on the content — an
 * instruction opens a user message, a stack trace closes a tool result — so both
 * are kept rather than guessing, weighted toward the head.
 */
export function elideMiddle(text: string, budget: number, marker = ELISION): string {
  if (text.length <= budget) return text;
  if (budget <= marker.length) return text.slice(0, Math.max(0, budget));
  const usable = budget - marker.length;
  const headLen = Math.floor(usable * HEAD_SHARE);
  const tailLen = usable - headLen;
  return text.slice(0, headLen) + marker + text.slice(text.length - tailLen);
}

function placeholder(m: Message): string {
  return `[omitted ${m.role} message, ${m.content.length} chars]`;
}

export interface FairTruncationResult {
  messages: Message[];
  /** Messages replaced by a placeholder. */
  omitted: number;
  /** Messages kept but shortened. */
  shortened: number;
}

/**
 * Fairly reduce `messages` to fit `budget` budget units (tokens by default in
 * the agent, characters when no measure is given).
 *
 * `messages` must be the *eligible* slice only — callers keep the system prompt
 * and the current round out of it, since neither is safe to abridge. Tool calls
 * attached to an assistant message are never touched: they pair with tool
 * results by id, and rewriting them would invalidate the transcript.
 */
export function truncateMessagesFairly(
  messages: readonly Message[],
  budget: number,
  measure: BudgetMeasure = charMeasure,
): FairTruncationResult {
  const sizes = messages.map((m) => measure.cost(m.content));
  const allocations = computeMaxMinFairAllocations(sizes, budget);

  let omitted = 0;
  let shortened = 0;
  const out = messages.map((m, i) => {
    if (allocations[i]! >= sizes[i]!) return m;
    const allocatedChars = measure.charsFor(allocations[i]!);
    const floor = m.role === "user" ? MIN_USEFUL_USER_CHARS : MIN_USEFUL_CHARS;
    if (allocatedChars < floor) {
      omitted += 1;
      return { ...m, content: placeholder(m) };
    }
    shortened += 1;
    return { ...m, content: elideMiddle(m.content, allocatedChars) };
  });

  return { messages: out, omitted, shortened };
}

/**
 * The banner explaining that history was abridged. Prepended to the first
 * reduced message so it reads as part of the transcript rather than arriving as
 * an extra turn (which would cost a round and could break tool-call pairing).
 */
export function truncationNotice(omitted: number, shortened: number): string {
  const parts: string[] = [];
  if (omitted > 0) parts.push(`${omitted} message(s) omitted`);
  if (shortened > 0) parts.push(`${shortened} shortened`);
  if (parts.length === 0) return "";
  return (
    `[Earlier history was reduced to fit the context budget: ${parts.join(", ")}. ` +
    `Details from those turns may be missing — re-read files or re-run commands ` +
    `rather than relying on remembered specifics.]\n`
  );
}
