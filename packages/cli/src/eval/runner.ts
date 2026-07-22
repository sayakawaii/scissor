import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent, ProviderId } from "@scissor/core";
import { createSession, recordToolEvent } from "../session.js";
import type { Tracer } from "../trace.js";
import { priceFor } from "../trace-report.js";
import { bareTarget } from "./bare.js";
import { EVAL_TASKS, findTasks, type EvalTask } from "./tasks.js";

export interface TaskResult {
  taskId: string;
  title: string;
  tags: string[];
  pass: boolean;
  detail: string;
  turns: number;
  elapsedMs: number;
  timedOut: boolean;
  error?: string;
  /** Prompt/completion tokens consumed by this task (when the target reports them). */
  promptTokens?: number;
  completionTokens?: number;
  /** Estimated USD cost for this task (when the model has a known price). */
  costUsd?: number;
}

export interface ProviderRun {
  /** Target label: a provider id for scissor, or an agent name (e.g. "goose"). */
  provider: string;
  model: string;
  results: TaskResult[];
  passed: number;
  total: number;
}

/** Minimal, non-interactive callbacks: auto-approve everything, no output. */
const QUIET_CALLBACKS = {
  onRequestApproval: async () => "approve" as const,
  onPresentPlan: async () => ({ action: "approve" as const }),
  onAskUser: async () => "proceed",
};

/**
 * Auto-approving callbacks that also feed the experience layer: they record
 * tool/turn/usage/verify events to the session tracer so eval and bench runs —
 * the most frequent, deterministic signal source — become experience data
 * (doc §4 "eval / bench：评估经验路由是否真正提高 pass rate"). Behavior is
 * identical to QUIET_CALLBACKS; only observability is added.
 */
function tracingQuietCallbacks(tracer: Tracer) {
  return {
    ...QUIET_CALLBACKS,
    onTurnStart: (turn: number) => tracer.record("turn", { turn }),
    onToolStart: (call: { id: string }) => tracer.toolStart(call.id),
    onToolEnd: (
      call: { id: string; name: string; arguments?: Record<string, unknown> },
      result: { isError?: boolean; content?: string },
    ) => recordToolEvent(tracer, call, result),
    onUsage: (u: { promptTokens?: number; completionTokens?: number; totalTokens?: number }) =>
      tracer.record("usage", { ...u }),
    onVerifyResult: (r: { ok: boolean; summary: string; skipped?: boolean }) =>
      tracer.record("verify", { ok: r.ok, summary: r.summary, skipped: r.skipped }),
  };
}

export interface EvalSession {
  agent: Agent;
  providerId: ProviderId;
  model: string;
  /** Present when tracing is enabled; wired so eval runs record experience data. */
  tracer?: Tracer;
}

/** Builds an agent session for a task; injectable so the harness is testable. */
export type EvalSessionFactory = (opts: {
  workspaceRoot: string;
  provider?: ProviderId;
  router?: boolean;
}) => Promise<EvalSession>;

const defaultSessionFactory: EvalSessionFactory = async ({ workspaceRoot, provider, router }) => {
  const s = await createSession({ workspaceRoot, provider, router, approvalPolicy: "auto" });
  return { agent: s.agent, providerId: s.providerId, model: s.model, tracer: s.tracer };
};

/** Result of a single task run by an AgentTarget. */
export interface TargetRunResult {
  finalText: string;
  turns: number;
  model?: string;
  ok: boolean;
  detail?: string;
  /** Tokens consumed (when the target can report them; external CLIs cannot). */
  promptTokens?: number;
  completionTokens?: number;
}

/** How the agent under test runs a single task inside a prepared workspace. */
export interface AgentTarget {
  label: string;
  runTask(task: EvalTask, workspaceRoot: string, timeoutMs: number): Promise<TargetRunResult>;
}

/** A callback fragment that sums prompt/completion tokens across a run. */
export function usageAccumulator(): {
  onUsage: (u: { promptTokens?: number; completionTokens?: number }) => void;
  totals: { promptTokens: number; completionTokens: number };
} {
  const totals = { promptTokens: 0, completionTokens: 0 };
  return {
    totals,
    onUsage: (u) => {
      totals.promptTokens += u.promptTokens ?? 0;
      totals.completionTokens += u.completionTokens ?? 0;
    },
  };
}

/** Estimate USD cost for a model + token counts, or undefined when unpriced. */
export function estimateCost(
  model: string | undefined,
  promptTokens: number,
  completionTokens: number,
): number | undefined {
  const price = priceFor(model);
  if (!price) return undefined;
  return (promptTokens / 1e6) * price.inputPer1M + (completionTokens / 1e6) * price.outputPer1M;
}

/** Build the token/cost fields for a TaskResult from a target's run result. */
function tokenFields(
  model: string,
  run: TargetRunResult,
): Pick<TaskResult, "promptTokens" | "completionTokens" | "costUsd"> {
  if (run.promptTokens === undefined && run.completionTokens === undefined) return {};
  const promptTokens = run.promptTokens ?? 0;
  const completionTokens = run.completionTokens ?? 0;
  const costUsd = estimateCost(model, promptTokens, completionTokens);
  return { promptTokens, completionTokens, ...(costUsd !== undefined ? { costUsd } : {}) };
}

/** A scissor (in-process) target for a given provider. */
export function scissorTarget(
  provider: ProviderId | undefined,
  factory: EvalSessionFactory = defaultSessionFactory,
  targetOpts: { router?: boolean } = {},
): AgentTarget {
  return {
    label: (provider ?? "default") + (targetOpts.router ? "+router" : ""),
    async runTask(task, workspaceRoot, timeoutMs) {
      const session = await factory({ workspaceRoot, provider, router: targetOpts.router });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const base = session.tracer ? tracingQuietCallbacks(session.tracer) : QUIET_CALLBACKS;
      const usage = usageAccumulator();
      const callbacks = {
        ...base,
        onUsage: (u: { promptTokens?: number; completionTokens?: number; totalTokens?: number }) => {
          usage.onUsage(u);
          (base as { onUsage?: (u: unknown) => void }).onUsage?.(u);
        },
      };
      try {
        const res = await session.agent.run(task.prompt, callbacks, controller.signal);
        return {
          finalText: res.finalText,
          turns: res.turns,
          model: session.model,
          ok: !res.aborted,
          detail: res.aborted ? "timed out" : undefined,
          promptTokens: usage.totals.promptTokens,
          completionTokens: usage.totals.completionTokens,
        };
      } finally {
        clearTimeout(timer);
        session.tracer?.close();
      }
    },
  };
}

export type ProgressEvent =
  | { type: "provider-start"; provider: string }
  | { type: "task-start"; provider: string; task: EvalTask }
  | { type: "task-end"; provider: string; result: TaskResult };

async function runOneTask(
  task: EvalTask,
  target: AgentTarget,
  timeoutMs: number,
  keep: boolean,
): Promise<{ result: TaskResult; model: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-eval-"));
  const started = Date.now();
  let model = "";
  const base = { taskId: task.id, title: task.title, tags: task.tags };
  try {
    if (task.setup) await task.setup(dir);
    const run = await target.runTask(task, dir, timeoutMs);
    model = run.model ?? "";
    const cost = tokenFields(model, run);
    if (!run.ok) {
      return {
        model,
        result: {
          ...base,
          pass: false,
          detail: run.detail ?? "agent run failed",
          turns: run.turns,
          elapsedMs: Date.now() - started,
          timedOut: run.detail === "timed out",
          ...cost,
        },
      };
    }
    const check = await task.check(dir, run.finalText);
    return {
      model,
      result: {
        ...base,
        pass: check.pass,
        detail: check.detail,
        turns: run.turns,
        elapsedMs: Date.now() - started,
        timedOut: false,
        ...cost,
      },
    };
  } catch (err) {
    return {
      model,
      result: {
        ...base,
        pass: false,
        detail: "threw",
        turns: 0,
        elapsedMs: Date.now() - started,
        timedOut: false,
        error: (err as Error).message,
      },
    };
  } finally {
    if (!keep) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface RunSuiteOptions {
  keep?: boolean;
  timeoutMs?: number;
  onProgress?: (event: ProgressEvent) => void;
}

/** Run a set of tasks against each target and return per-target results. */
export async function runSuite(
  tasks: EvalTask[],
  targets: AgentTarget[],
  opts: RunSuiteOptions = {},
): Promise<ProviderRun[]> {
  const timeoutMs = opts.timeoutMs ?? 150_000;
  const runs: ProviderRun[] = [];
  for (const target of targets) {
    opts.onProgress?.({ type: "provider-start", provider: target.label });
    const results: TaskResult[] = [];
    let model = "";
    for (const task of tasks) {
      opts.onProgress?.({ type: "task-start", provider: target.label, task });
      const { result, model: m } = await runOneTask(
        task,
        target,
        task.timeoutMs ?? timeoutMs,
        opts.keep ?? false,
      );
      if (m) model = m;
      results.push(result);
      opts.onProgress?.({ type: "task-end", provider: target.label, result });
    }
    runs.push({
      provider: target.label,
      model,
      results,
      passed: results.filter((r) => r.pass).length,
      total: results.length,
    });
  }
  return runs;
}

export interface RunEvalOptions {
  providers?: ProviderId[];
  taskIds?: string[];
  keep?: boolean;
  timeoutMs?: number;
  onProgress?: (event: ProgressEvent) => void;
  sessionFactory?: EvalSessionFactory;
  /** Run scissor with the heuristic model router enabled. */
  router?: boolean;
  /** Use the bare minimal-harness baseline instead of scissor. */
  bare?: boolean;
}

/** Run the default eval suite with scissor (or the bare baseline) per provider. */
export async function runEval(opts: RunEvalOptions = {}): Promise<ProviderRun[]> {
  const tasks = findTasks(opts.taskIds);
  const factory = opts.sessionFactory ?? defaultSessionFactory;
  const providers = opts.providers ?? [undefined as unknown as ProviderId];
  const targets = providers.map((p) =>
    opts.bare ? bareTarget({ provider: p }) : scissorTarget(p, factory, { router: opts.router }),
  );
  return runSuite(tasks, targets, {
    keep: opts.keep,
    timeoutMs: opts.timeoutMs,
    onProgress: opts.onProgress,
  });
}

export { EVAL_TASKS };
