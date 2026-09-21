import { promises as fs } from "node:fs";
import path from "node:path";
import {
  applyEnvOverrides,
  loadConfig,
  PROVIDER_IDS,
  type ProviderId,
} from "@scissor/core";
import { commandAgentFromTemplate, gooseTarget } from "../eval/agents.js";
import { BENCH_TASKS } from "../eval/bench-tasks.js";
import { formatReport, toResultJson } from "../eval/report.js";
import { runSuite, scissorTarget, type AgentTarget, type ProgressEvent } from "../eval/runner.js";
import { theme } from "../ui/render.js";

export interface BenchCommandOptions {
  /** Which agent to benchmark: scissor (default), goose, or custom. */
  agent?: string;
  /** Command template for --agent custom, e.g. "mytool run -t {PROMPT}". */
  agentCmd?: string;
  /** For --agent scissor: comma-separated provider ids, or "all". */
  provider?: string;
  /** Comma-separated task ids to run (default: all bench tasks). */
  task?: string;
  json?: string;
  keep?: boolean;
  list?: boolean;
  strict?: boolean;
}

function parseList(v?: string): string[] | undefined {
  if (!v) return undefined;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

async function resolveProviders(spec?: string): Promise<ProviderId[]> {
  const config = applyEnvOverrides(await loadConfig());
  const configured = PROVIDER_IDS.filter((id) => config.providers[id]?.apiKey);
  if (!spec) return [config.defaultProvider];
  if (spec === "all") return configured.length > 0 ? configured : [config.defaultProvider];
  const requested = parseList(spec) as ProviderId[];
  const invalid = requested.filter((p) => !(PROVIDER_IDS as string[]).includes(p));
  if (invalid.length > 0) {
    throw new Error(`Unknown provider(s): ${invalid.join(", ")}. Valid: ${PROVIDER_IDS.join(", ")}`);
  }
  return requested;
}

async function buildTargets(opts: BenchCommandOptions): Promise<AgentTarget[]> {
  const agent = (opts.agent ?? "scissor").toLowerCase();
  if (agent === "goose") return [gooseTarget()];
  if (agent === "custom") {
    if (!opts.agentCmd) throw new Error("--agent custom requires --agent-cmd \"<command> {PROMPT}\"");
    return [commandAgentFromTemplate("custom", opts.agentCmd)];
  }
  if (agent === "scissor") {
    const providers = await resolveProviders(opts.provider);
    return providers.map((p) => scissorTarget(p));
  }
  throw new Error(`Unknown --agent "${agent}". Use scissor, goose, or custom.`);
}

/** Entry point for `scissor bench`. Returns a process exit code. */
export async function runBenchCommand(opts: BenchCommandOptions): Promise<number> {
  if (opts.list) {
    process.stdout.write(theme.bold("Benchmark tasks:\n"));
    for (const t of BENCH_TASKS) {
      process.stdout.write(`  ${theme.brand(t.id)}  ${theme.dim(`[${t.tags.join(", ")}]`)}  ${t.title}\n`);
    }
    return 0;
  }

  let targets: AgentTarget[];
  try {
    targets = await buildTargets(opts);
  } catch (err) {
    process.stderr.write(theme.err((err as Error).message) + "\n");
    return 2;
  }

  const ids = new Set(parseList(opts.task));
  const tasks = ids.size > 0 ? BENCH_TASKS.filter((t) => ids.has(t.id)) : BENCH_TASKS;
  if (tasks.length === 0) {
    process.stderr.write(theme.err("No matching benchmark tasks.") + "\n");
    return 2;
  }

  process.stdout.write(
    theme.brand("scissor bench") +
      theme.dim(
        ` · agents: ${targets.map((t) => t.label).join(", ")} · tasks: ${
          ids.size > 0 ? [...ids].join(", ") : "all"
        }\n`,
      ),
  );

  const onProgress = (e: ProgressEvent): void => {
    if (e.type === "provider-start") {
      process.stdout.write(theme.dim(`\n[${e.provider}]\n`));
    } else if (e.type === "task-start") {
      process.stdout.write(theme.dim(`  … ${e.task.id}\r`));
    } else if (e.type === "task-end") {
      const mark = e.result.pass ? theme.ok("\u2713") : theme.err("\u2717");
      process.stdout.write(
        `  ${mark} ${e.result.taskId} ${theme.dim(`(${e.result.turns}t ${(e.result.elapsedMs / 1000).toFixed(1)}s)`)} ${
          e.result.pass ? "" : theme.warn(e.result.detail)
        }\n`,
      );
    }
  };

  const runs = await runSuite(tasks, targets, { keep: opts.keep, onProgress });

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
