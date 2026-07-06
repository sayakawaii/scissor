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
  provider: ProviderId;
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
}) => Promise<EvalSession>;

const defaultSessionFactory: EvalSessionFactory = async ({ workspaceRoot, provider }) => {
  const s = await createSession({ workspaceRoot, provider, approvalPolicy: "auto" });
  return { agent: s.agent, providerId: s.providerId, model: s.model };
};

export interface RunEvalOptions {
  providers?: ProviderId[];
  taskIds?: string[];
  keep?: boolean;
  timeoutMs?: number;
  onProgress?: (event: ProgressEvent) => void;
  sessionFactory?: EvalSessionFactory;
}

export type ProgressEvent =
  | { type: "provider-start"; provider: ProviderId }
  | { type: "task-start"; provider: ProviderId; task: EvalTask }
  | { type: "task-end"; provider: ProviderId; result: TaskResult };

async function runOneTask(
  task: EvalTask,
  provider: ProviderId | undefined,
  factory: EvalSessionFactory,
  timeoutMs: number,
  keep: boolean,
): Promise<{ result: Omit<TaskResult, "taskId" | "title" | "tags">; model: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-eval-"));
  const started = Date.now();
  let turns = 0;
  let model = "";
  try {
    if (task.setup) await task.setup(dir);
    const session = await factory({ workspaceRoot: dir, provider });
    model = session.model;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let finalText = "";
    let timedOut = false;
    try {
      const res = await session.agent.run(task.prompt, QUIET_CALLBACKS, controller.signal);
      finalText = res.finalText;
      turns = res.turns;
      timedOut = res.aborted;
    } finally {
      clearTimeout(timer);
    }

    if (timedOut) {
      return {
        model,
        result: { pass: false, detail: "timed out", turns, elapsedMs: Date.now() - started, timedOut: true },
      };
    }
    const check = await task.check(dir, finalText);
    return {
      model,
      result: { pass: check.pass, detail: check.detail, turns, elapsedMs: Date.now() - started, timedOut: false },
    };
  } catch (err) {
    return {
      model,
      result: {
        pass: false,
        detail: "threw",
        turns,
        elapsedMs: Date.now() - started,
        timedOut: false,
        error: (err as Error).message,
      },
    };
  } finally {
    if (!keep) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Run the eval suite for each provider and return per-provider results. */
export async function runEval(opts: RunEvalOptions = {}): Promise<ProviderRun[]> {
  const tasks = findTasks(opts.taskIds);
  const factory = opts.sessionFactory ?? defaultSessionFactory;
  const timeoutMs = opts.timeoutMs ?? 150_000;
  const providers = opts.providers ?? [undefined as unknown as ProviderId];
  const runs: ProviderRun[] = [];

  for (const provider of providers) {
    opts.onProgress?.({ type: "provider-start", provider });
    const results: TaskResult[] = [];
    let model = "";
    for (const task of tasks) {
      opts.onProgress?.({ type: "task-start", provider, task });
      const { result, model: m } = await runOneTask(
        task,
        provider,
        factory,
        task.timeoutMs ?? timeoutMs,
        opts.keep ?? false,
      );
      if (m) model = m;
      const full: TaskResult = { taskId: task.id, title: task.title, tags: task.tags, ...result };
      results.push(full);
      opts.onProgress?.({ type: "task-end", provider, result: full });
    }
    runs.push({
      provider,
      model,
      results,
      passed: results.filter((r) => r.pass).length,
      total: results.length,
    });
  }
  return runs;
}

export { EVAL_TASKS };
