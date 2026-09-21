import { coerceNumber } from "./coerce.js";

/**
 * Per-tool execution limits.
 *
 * A tool call used to be awaited with no upper bound at all, so one hung MCP
 * server or wedged child process could stall the agent indefinitely with no
 * output and no way back. The fix is not a single flat number: `read_file`
 * finishing in milliseconds and a sub-agent working for half an hour want very
 * different ceilings, and a caller that explicitly asked to block for ten
 * minutes should not be cut off at two.
 *
 * So limits are snapped to a few coarse tiers derived from the tool and its
 * arguments. These are safety nets, not budgets — nothing is expected to run
 * anywhere near its tier — which is why the tiers are generous and why crossing
 * one is reported as an actionable message rather than a bare failure.
 */

const MINUTE = 60_000;

/** Coarse tiers a tool's limit snaps to. */
export const TIMEOUT_TIERS = [5 * MINUTE, 15 * MINUTE, 30 * MINUTE, 60 * MINUTE] as const;

/** Default ceiling for an ordinary tool call. */
export const DEFAULT_TOOL_TIMEOUT_MS = TIMEOUT_TIERS[0];

/** Sub-agents run whole sub-tasks, so they get the top tier. */
export const SUBAGENT_TOOL_TIMEOUT_MS = TIMEOUT_TIERS[3];

/**
 * Headroom added on top of a caller-requested `block_until_ms` so the tool gets
 * to return its own "still running in the background" result rather than being
 * killed on the exact millisecond it was told to stop waiting.
 */
export const TIMEOUT_GRACE_MS = 30_000;

const SUBAGENT_TOOLS = new Set(["spawn_subagent", "spawn_subagents"]);

/** The smallest tier that covers `needed`, or `needed` itself if none does. */
function snapToTier(needed: number): number {
  return TIMEOUT_TIERS.find((tier) => tier >= needed) ?? needed;
}

/**
 * The execution ceiling for one tool call, from the tool name and its arguments.
 * A `block_until_ms` argument raises the ceiling (plus grace) so tools that
 * deliberately block — `run_shell`, `await_shell` — are never cut short of the
 * window they were asked for.
 */
export function suggestedToolTimeoutMs(
  name: string,
  args: Record<string, unknown> = {},
): number {
  const base = SUBAGENT_TOOLS.has(name) ? SUBAGENT_TOOL_TIMEOUT_MS : DEFAULT_TOOL_TIMEOUT_MS;
  const blockUntil = coerceNumber(args.block_until_ms);
  if (blockUntil === undefined || blockUntil <= 0) return base;
  return Math.max(base, snapToTier(blockUntil + TIMEOUT_GRACE_MS));
}

/** Human-friendly duration for a limit, e.g. "5m" or "90s". */
export function formatTimeout(ms: number): string {
  if (ms % MINUTE === 0) return `${ms / MINUTE}m`;
  return `${Math.round(ms / 1000)}s`;
}

/**
 * The result handed back when a call crosses its ceiling. Says what to do next,
 * because the useful response to "this took too long" is almost always "run it
 * differently", not "run it again".
 */
export function toolTimeoutMessage(name: string, ms: number): string {
  const limit = formatTimeout(ms);
  const advice =
    name === "run_shell"
      ? "Re-run it with block_until_ms: 0 to start it in the background, then poll with await_shell (optionally with a pattern) instead of blocking on it."
      : name === "await_shell"
        ? "Poll with a shorter block_until_ms, or check the shell's output file directly."
        : SUBAGENT_TOOLS.has(name)
          ? "Split the delegated task into smaller pieces, or do it yourself in this conversation."
          : "Narrow the request (a smaller range, a more specific path or query) or use a different tool.";
  return (
    `${name} exceeded its ${limit} execution limit and was abandoned; it may still be ` +
    `running. ${advice}`
  );
}
