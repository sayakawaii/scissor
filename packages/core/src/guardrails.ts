import { promises as fs } from "node:fs";
import path from "node:path";
import type { OperatingPoint } from "./experience/estimator.js";
import { isSourceFile, isTestFile } from "./tdd.js";
import { displayPath } from "./tools/paths.js";
import { elideMiddle } from "./truncate.js";
import type {
  ApprovalPolicy,
  Guardrail,
  Tool,
  ToolCall,
  ToolPreview,
  ToolResult,
} from "./types.js";

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

/** Tools that gather broad/repo-wide context — skipped on a confident local edit. */
const BROAD_CONTEXT_TOOLS = new Set(["retrieve"]);

/** A localized single-site edit we're confident about → the E3 level-1 fast path. */
function isConfidentLocal(op: OperatingPoint | undefined): boolean {
  return !!op && op.difficulty === 1 && op.scope === "local" && op.confidence >= 0.7;
}

/**
 * E3 "Execute the minimum viable path" guard (Phase 2; arXiv:2607.13034 §4.3).
 *
 * When the up-front estimate judges the task a confident, localized single-file
 * edit, broad context-gathering (semantic `retrieve`) is wasted budget — level 1
 * is "localize the one site and edit it". This vetoes those tools for that run
 * and nudges the agent to read the named file directly. It is deliberately
 * conservative: it fires ONLY on difficulty-1/local/high-confidence estimates
 * (vague "find the bug" prompts estimate as difficulty-2 and are untouched), and
 * the Expand stage recovers a mis-scoped task on verification failure. Opt-in via
 * the caller (off by default), reading the current run's operating point through
 * `getOp` so it always reflects the task in flight.
 */
export function createMinViablePathGuard(getOp: () => OperatingPoint | undefined): Guardrail {
  return {
    name: "min-viable-path",
    beforeTool(call) {
      if (!BROAD_CONTEXT_TOOLS.has(call.name) || !isConfidentLocal(getOp())) {
        return { allow: true };
      }
      return {
        allow: false,
        reason: "min-viable-path",
        result: {
          content:
            "Skipped broad retrieval: this task was estimated as a localized single-file edit " +
            "(E3 minimum-viable path). Read the specific file(s) named in the request directly " +
            "instead. If you cannot locate the target that way, proceed with your best attempt — " +
            "scope will widen automatically if verification fails.",
          isError: false,
        },
      };
    },
  };
}

export const TOOL_OUTPUT_DIRNAME = path.join(".scissor", "tool-output");

/**
 * Default spill threshold. Deliberately above the largest built-in per-tool cap
 * (`run_shell`'s 30 KiB) so tools that already bound and mirror their own output
 * stay inline, and only genuinely unbounded results — a large `read_file`, a
 * chatty MCP tool — get spilled.
 */
const DEFAULT_MAX_RESULT_CHARS = 32_000;

/**
 * Marker opening the notice appended to a spilled result. Also how the guard
 * recognizes its own output: the excerpt plus notice can land slightly over the
 * budget, and re-spilling would overwrite the saved file with the excerpt.
 */
const SPILL_MARKER = "[Output truncated:";

export interface OutputSpillGuardOptions {
  workspaceRoot: string;
  /** Inline character budget before a result is spilled to a file. */
  maxChars?: number;
}

/**
 * Make a tool call id safe to use as a filename. Ids come from the provider, so
 * separators and dots are collapsed rather than trusted — the result can only
 * ever name a file directly inside the output directory.
 */
function safeCallId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return cleaned || "call";
}

/** Marker separating the kept head from the kept tail of a spilled result. */
const SPILL_ELISION = "\n\n[... middle of the output omitted ...]\n\n";

/**
 * Output-spill guard: writes an oversized tool result to a file in the workspace
 * and hands the model a bounded excerpt plus the path.
 *
 * Without this, a single large result (a 200 KB file read, a verbose MCP tool)
 * either blows a large hole in the context budget or gets silently truncated
 * with the remainder lost — and the model, not knowing which, tends to retry the
 * same call hoping for more. Spilling keeps the transcript small while leaving
 * the full text reachable through `read_file`, and says so explicitly so the
 * retry never looks worthwhile.
 *
 * Applied as one `afterTool` hook so it covers every tool uniformly, including
 * MCP tools discovered at runtime.
 */
export function createOutputSpillGuard(opts: OutputSpillGuardOptions): Guardrail {
  const envMax = Number.parseInt(process.env.SCISSOR_TOOL_OUTPUT_MAX ?? "", 10);
  const maxChars =
    opts.maxChars ??
    (Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_RESULT_CHARS);

  return {
    name: "output-spill",
    async afterTool(call, result): Promise<ToolResult | void> {
      const total = result.content.length;
      if (total <= maxChars) return;
      if (result.content.includes(SPILL_MARKER)) return;

      const file = path.join(
        opts.workspaceRoot,
        TOOL_OUTPUT_DIRNAME,
        `${safeCallId(call.id)}.txt`,
      );
      let written = false;
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, result.content, "utf8");
        written = true;
      } catch {
        /* fall through to plain truncation */
      }

      const excerpt = elideMiddle(result.content, maxChars, SPILL_ELISION);
      const omitted = total - excerpt.length;
      const notice = written
        ? `\n\n${SPILL_MARKER} ${total} chars exceeded the ${maxChars}-char inline limit, so ` +
          `~${omitted} chars were omitted above. The FULL output is in ` +
          `${displayPath(opts.workspaceRoot, file)} — read that file (use offset/limit to page ` +
          `through it) if you need the rest. Re-running this call will not return more inline.]`
        : `\n\n${SPILL_MARKER} ${total} chars exceeded the ${maxChars}-char inline limit and ` +
          `could not be written to a file, so ~${omitted} chars were discarded. Do not retry ` +
          `this call expecting the full output — narrow the request instead.]`;

      return { ...result, content: excerpt + notice };
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
      // Categorically refused calls are a dead end, never a prompt: there is no
      // answer that would let them run, so asking would be theatre and would
      // teach the user that these prompts are noise. The tool refuses again on
      // its own if this is ever reached another way.
      if (preview?.blocked) {
        return {
          allow: false,
          reason: "refused by safety policy",
          result: { content: preview.blocked, isError: true },
        };
      }
      if (!mutatingNeedsApproval(policy, tool, preview, alwaysApproved)) return { allow: true };
      // No UI to ask. Previously this returned allow, which meant a headless run
      // executed exactly the calls we had decided needed a human — the check
      // silently inverted itself in the one situation where nobody was watching.
      // A dangerous call with no one to approve it is refused; anything else that
      // merely needed a routine confirmation proceeds.
      if (!requestApproval || !preview) {
        if (!preview?.dangerous) return { allow: true };
        return {
          allow: false,
          reason: "no approver available",
          result: {
            content:
              `This action needs the user's confirmation, and there is no interactive ` +
              `user in this run, so it was not performed. Do not retry it. Continue with ` +
              `the parts of the task that do not require confirmation, and report what ` +
              `was left undone.`,
            isError: false,
          },
        };
      }
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
