import { isSourceFile, isTestFile } from "./tdd.js";
import type { ApprovalPolicy, Guardrail, Tool, ToolCall, ToolPreview } from "./types.js";

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

/**
 * Test-first (TDD) guard: blocks edits to source files until a test file has
 * been created or edited this session, enforcing a red-green workflow. State is
 * per-session and cleared on Agent.reset(). Only relevant when TDD mode is on.
 */
export function createTddGuard(): Guardrail {
  let testFileTouched = false;
  return {
    name: "tdd",
    beforeTool(call) {
      if (call.name !== "write_file" && call.name !== "edit_file") return { allow: true };
      const target = String(call.arguments.path ?? "");
      if (target && isTestFile(target)) {
        testFileTouched = true;
        return { allow: true };
      }
      if (target && isSourceFile(target) && !testFileTouched) {
        return {
          allow: false,
          reason: "test-first",
          result: {
            content:
              `TDD mode is on: write a test first. "${target}" is source code, but no test ` +
              `file has been created or edited yet this session. Create a failing test (e.g. ` +
              `a *.test.* file or a file under tests/) that specifies the desired behavior, ` +
              `then implement "${target}" to make it pass.`,
            isError: true,
          },
        };
      }
      return { allow: true };
    },
    reset() {
      testFileTouched = false;
    },
  };
}

/** Whether a mutating tool needs approval under the given policy. */
function mutatingNeedsApproval(
  policy: ApprovalPolicy,
  tool: Tool,
  preview: ToolPreview | undefined,
  alwaysApproved: Set<string>,
): boolean {
  if (alwaysApproved.has(tool.name)) return preview?.dangerous ?? false;
  switch (policy) {
    case "confirm-each":
      return true;
    case "auto":
    case "plan-gate":
    default:
      // In plan-gate the plan is approved up front; only prompt for individually
      // dangerous actions (same as auto).
      return preview?.dangerous ?? false;
  }
}

/**
 * Approval guard: for mutating tools, asks the user to approve the call per the
 * current approval policy. "always" is remembered for the session (cleared on
 * reset); "reject" feeds back a non-error message so the model tries something
 * else. Non-mutating tools and the "auto" fast path pass straight through.
 */
export function createApprovalGuard(): Guardrail {
  const alwaysApproved = new Set<string>();
  return {
    name: "approval",
    async beforeTool(call, gctx) {
      const { tool, preview, policy, requestApproval } = gctx;
      if (!tool.mutating) return { allow: true };
      if (!mutatingNeedsApproval(policy, tool, preview, alwaysApproved)) return { allow: true };
      // No UI to ask, or no preview to show: proceed (matches prior behavior).
      if (!requestApproval || !preview) return { allow: true };
      const decision = await requestApproval(call, preview);
      if (decision === "always") {
        alwaysApproved.add(tool.name);
        return { allow: true };
      }
      if (decision === "reject") {
        return {
          allow: false,
          reason: "user rejected",
          result: {
            content: "User rejected this action. Do not retry it; consider an alternative.",
            isError: false,
          },
        };
      }
      return { allow: true };
    },
    reset() {
      alwaysApproved.clear();
    },
  };
}
