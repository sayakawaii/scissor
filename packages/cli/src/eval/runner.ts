import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent, ProviderId } from "@scissor/core";
import { createSession } from "../session.js";
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

export interface EvalSession {
  agent: Agent;
  providerId: ProviderId;
  model: string;
}

/** Builds an agent session for a task; injectable so the harness is testable. */
export type EvalSessionFactory = (opts: {
  workspaceRoot: string;
  provider?: ProviderId;
  router?: boolean;
}) => Promise<EvalSession>;

const defaultSessionFactory: EvalSessionFactory = async ({ workspaceRoot, provider, router }) => {
  const s = await createSession({ workspaceRoot, provider, router, approvalPolicy: "auto" });
  return { agent: s.agent, providerId: s.providerId, model: s.model };
};

/** How the agent under test runs a single task inside a prepared workspace. */
export interface AgentTarget {
  label: string;
  runTask(
    task: EvalTask,
    workspaceRoot: string,
    timeoutMs: number,
  ): Promise<{ finalText: string; turns: number; model?: string; ok: boolean; detail?: string }>;
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
      try {
        const res = await session.agent.run(task.prompt, QUIET_CALLBACKS, controller.signal);
        return {
          finalText: res.finalText,
          turns: res.turns,
          model: session.model,
          ok: !res.aborted,
          detail: res.aborted ? "timed out" : undefined,
        };
      } finally {
        clearTimeout(timer);
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
}

/** Run the default eval suite with scissor for each provider. */
export async function runEval(opts: RunEvalOptions = {}): Promise<ProviderRun[]> {
  const tasks = findTasks(opts.taskIds);
  const factory = opts.sessionFactory ?? defaultSessionFactory;
  const providers = opts.providers ?? [undefined as unknown as ProviderId];
  const targets = providers.map((p) => scissorTarget(p, factory, { router: opts.router }));
  return runSuite(tasks, targets, {
    keep: opts.keep,
    timeoutMs: opts.timeoutMs,
    onProgress: opts.onProgress,
  });
}

export { EVAL_TASKS };
