import { promises as fs } from "node:fs";
import path from "node:path";
import {
  applyEnvOverrides,
  loadConfig,
  PROVIDER_IDS,
  type ProviderId,
} from "@scissor/core";
import { formatReport, toResultJson } from "../eval/report.js";
import { EVAL_TASKS, runEval, type ProgressEvent } from "../eval/runner.js";
import { theme } from "../ui/render.js";

export interface EvalCommandOptions {
  /** Comma-separated provider ids, or "all" for every configured provider. */
  provider?: string;
  /** Comma-separated task ids to run (default: all). */
  task?: string;
  /** Write results JSON to this path. */
  json?: string;
  keep?: boolean;
  list?: boolean;
  /** Exit non-zero if any task fails. */
  strict?: boolean;
  /** Run scissor with the heuristic model router enabled. */
  router?: boolean;
}

function parseList(v?: string): string[] | undefined {
  if (!v) return undefined;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

async function resolveProviders(spec?: string): Promise<ProviderId[]> {
  const config = applyEnvOverrides(await loadConfig());
  const configured = PROVIDER_IDS.filter((id) => config.providers[id]?.apiKey);
  if (!spec) return [config.defaultProvider];
  if (spec === "all") {
    return configured.length > 0 ? configured : [config.defaultProvider];
  }
  const requested = parseList(spec) as ProviderId[];
  const invalid = requested.filter((p) => !(PROVIDER_IDS as string[]).includes(p));
  if (invalid.length > 0) {
    throw new Error(`Unknown provider(s): ${invalid.join(", ")}. Valid: ${PROVIDER_IDS.join(", ")}`);
  }
  return requested;
}

/** Entry point for `scissor eval`. Returns a process exit code. */
export async function runEvalCommand(opts: EvalCommandOptions): Promise<number> {
  if (opts.list) {
    process.stdout.write(theme.bold("Eval tasks:\n"));
    for (const t of EVAL_TASKS) {
      process.stdout.write(`  ${theme.brand(t.id)}  ${theme.dim(`[${t.tags.join(", ")}]`)}  ${t.title}\n`);
    }
    return 0;
  }

  let providers: ProviderId[];
  try {
    providers = await resolveProviders(opts.provider);
  } catch (err) {
    process.stderr.write(theme.err((err as Error).message) + "\n");
    return 2;
  }

  const taskIds = parseList(opts.task);
  process.stdout.write(
    theme.brand("scissor eval") +
      theme.dim(` · providers: ${providers.join(", ")} · tasks: ${taskIds?.join(", ") ?? "all"}\n`),
  );

  const onProgress = (e: ProgressEvent): void => {
    if (e.type === "task-start") {
      process.stdout.write(theme.dim(`  … ${e.task.id}\r`));
    } else if (e.type === "task-end") {
      const mark = e.result.pass ? theme.ok("\u2713") : theme.err("\u2717");
      process.stdout.write(
        `  ${mark} ${e.result.taskId} ${theme.dim(`(${e.result.turns}t ${(e.result.elapsedMs / 1000).toFixed(1)}s)`)}\n`,
      );
    }
  };

  const runs = await runEval({ providers, taskIds, keep: opts.keep, router: opts.router, onProgress });

  process.stdout.write(formatReport(runs));

  if (opts.json) {
    const abs = path.resolve(opts.json);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, toResultJson(runs) + "\n", "utf8");
    process.stdout.write(theme.dim(`\nResults written to ${abs}\n`));
  }

  const anyFail = runs.some((r) => r.passed < r.total);
  return opts.strict && anyFail ? 1 : 0;
}
