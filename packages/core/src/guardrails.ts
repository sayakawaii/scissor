import type { Guardrail, ToolCall } from "./types.js";

/** Deterministic JSON: object keys sorted so equal args produce equal strings. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

function callKey(call: ToolCall): string {
  return `${call.name}:${stableStringify(call.arguments)}`;
}

export interface OscillationGuardOptions {
  /** How many identical failures are tolerated before the call is blocked. */
  limit?: number;
}

/**
 * Oscillation guard: detects the agent repeating the *exact same* tool call
 * after it has already failed `limit` times and blocks further attempts, forcing
 * a change of approach instead of looping. A successful call clears the streak.
 */
export function createOscillationGuard(opts: OscillationGuardOptions = {}): Guardrail {
  const limit = Math.max(1, opts.limit ?? 3);
  const failures = new Map<string, number>();

  return {
    name: "oscillation",
    beforeTool(call) {
      const n = failures.get(callKey(call)) ?? 0;
      if (n >= limit) {
        return {
          allow: false,
          reason:
            `This exact ${call.name} call has already failed ${n} time(s). ` +
            `Stop repeating it — inspect the previous error, change the arguments, ` +
            `or try a different tool or approach.`,
        };
      }
      return { allow: true };
    },
    afterTool(call, result) {
      const key = callKey(call);
      if (result.isError) {
        failures.set(key, (failures.get(key) ?? 0) + 1);
      } else {
        failures.delete(key);
      }
    },
  };
}
