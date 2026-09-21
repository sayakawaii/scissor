/**
 * `scissor benchmark` — run a fixed task set across several provider/model arms
 * and emit a publishable comparison (JSON + Markdown).
 *
 * This composes machinery that already exists rather than adding a second
 * harness: `runEval` executes the tasks, `matrix.ts` aggregates and renders. The
 * command's own job is narrow — resolve arms, hold the harness fixed across
 * them, repeat N times, and write artifacts somewhere committable.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  applyEnvOverrides,
  loadConfig,
  PROVIDER_DEFAULTS,
  PROVIDER_IDS,
  type ProviderId,
} from "@scissor/core";
import { BENCH_TASKS } from "../eval/bench-tasks.js";
import {
  buildBenchmarkReport,
  formatBenchmarkMarkdown,
  summarizeArm,
  type ArmSpec,
  type ArmSummary,
  type BenchmarkProvenance,
  type PricingRecord,
} from "../eval/matrix.js";
import { runEval, type ProgressEvent } from "../eval/runner.js";
import { EVAL_TASKS, type EvalTask } from "../eval/tasks.js";
import { exec, getScissorRepoRoot } from "../self/repo.js";
import { priceFor } from "../trace-report.js";
import { theme } from "../ui/render.js";
import { VERSION } from "../version.js";

/** Where committed benchmark artifacts live (NOT gitignored, unlike `evals/`). */
export const BENCHMARK_DIR = "benchmarks";

/**
 * Where the prices in MODEL_PRICES came from. Stated in the artifact so a
 * reader can re-check them rather than trusting our arithmetic.
 */
export const PRICING_SOURCE =
  "public list prices from each provider's published pricing/model catalog";

/** Env vars that would make arms differ by more than the model. */
const EXP_ENV = ["SCISSOR_EXPERIENCE_ADVICE", "SCISSOR_EXPERIENCE_ROUTE"] as const;

export interface BenchmarkCommandOptions {
  /**
   * Arms to compare. Either bare provider ids ("nebius,deepseek") or
   * `label=provider:model` for explicit model pins.
   */
  arm?: string;
  /** Task set: "eval" (6 hermetic), "bench" (11), or "all". */
  tasks?: string;
  /** Comma-separated task ids, overriding --tasks. */
  task?: string;
  /** Iterations per arm (default 1). More runs shrink the confidence interval. */
  runs?: string;
  /** Output directory for artifacts (default `benchmarks/`). */
  out?: string;
  /** Per-task timeout in ms. */
  timeout?: string;
  /** Print the plan (arms, tasks, request count) and exit without running. */
  dryRun?: boolean;
}

function parseList(v?: string): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Parse one arm spec. `provider` uses that provider's configured/default model;
 * `label=provider:model` pins a model, which is how the Nemotron tiers (Nano /
 * Super / Ultra) become separate arms on one key.
 */
export function parseArm(spec: string, defaultModelFor: (p: string) => string): ArmSpec {
  const eq = spec.indexOf("=");
  const label = eq >= 0 ? spec.slice(0, eq).trim() : "";
  const body = eq >= 0 ? spec.slice(eq + 1).trim() : spec.trim();
  const colon = body.indexOf(":");
  const provider = (colon >= 0 ? body.slice(0, colon) : body).trim();
  const model = colon >= 0 ? body.slice(colon + 1).trim() : "";
  if (!provider) throw new Error(`Invalid arm "${spec}": missing provider.`);
  if (!(PROVIDER_IDS as readonly string[]).includes(provider)) {
    throw new Error(`Unknown provider "${provider}" in arm "${spec}". Valid: ${PROVIDER_IDS.join(", ")}`);
  }
  return {
    id: label || (model ? `${provider}:${model.split("/").pop()}` : provider),
    provider,
    model: model || defaultModelFor(provider),
  };
}

/** Resolve the named task set. */
export function resolveTaskSet(opts: BenchmarkCommandOptions): { name: string; tasks: EvalTask[] } {
  const ids = parseList(opts.task);
  if (ids.length > 0) {
    const set = new Set(ids);
    const tasks = [...EVAL_TASKS, ...BENCH_TASKS].filter((t) => set.has(t.id));
    return { name: `custom (${ids.length} ids)`, tasks };
  }
  const which = (opts.tasks ?? "eval").toLowerCase();
  if (which === "eval") return { name: "eval", tasks: [...EVAL_TASKS] };
  if (which === "bench") return { name: "bench", tasks: [...BENCH_TASKS] };
  if (which === "all") return { name: "eval+bench", tasks: [...EVAL_TASKS, ...BENCH_TASKS] };
  throw new Error(`Unknown --tasks "${which}". Use: eval | bench | all`);
}

/** Short commit sha + dirty flag, so the code under test is pinned in the artifact. */
async function gitProvenance(): Promise<{ gitCommit?: string; gitDirty?: boolean }> {
  try {
    const root = getScissorRepoRoot();
    const rev = await exec("git", ["rev-parse", "--short", "HEAD"], root, 5000);
    if (!rev.ok) return {};
    const status = await exec("git", ["status", "--porcelain"], root, 5000);
    return {
      gitCommit: rev.stdout.trim(),
      gitDirty: status.ok && status.stdout.trim().length > 0,
    };
  } catch {
    return {};
  }
}

/** Collect the prices actually applied, so the cost column is auditable. */
function pricingFor(arms: ArmSpec[]): PricingRecord[] {
  const out: PricingRecord[] = [];
  for (const a of arms) {
    if (out.some((p) => p.model === a.model)) continue;
    const price = priceFor(a.model);
    if (price) {
      out.push({ model: a.model, inputPer1M: price.inputPer1M, outputPer1M: price.outputPer1M });
    }
  }
  return out;
}

/** A filename-safe stamp; no host or user information. */
function stamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
}

export async function runBenchmarkCommand(opts: BenchmarkCommandOptions): Promise<number> {
  const config = applyEnvOverrides(await loadConfig());
  const defaultModelFor = (p: string): string =>
    config.providers[p as ProviderId]?.model?.trim() || PROVIDER_DEFAULTS[p as ProviderId].model;

  let arms: ArmSpec[];
  let taskSet: { name: string; tasks: EvalTask[] };
  try {
    const specs = parseList(opts.arm);
    if (specs.length === 0) throw new Error("--arm is required, e.g. --arm nebius,deepseek");
    arms = specs.map((s) => parseArm(s, defaultModelFor));
    const dupes = arms.map((a) => a.id).filter((id, i, xs) => xs.indexOf(id) !== i);
    if (dupes.length) throw new Error(`Duplicate arm id(s): ${[...new Set(dupes)].join(", ")}`);
    taskSet = resolveTaskSet(opts);
  } catch (err) {
    process.stderr.write(theme.err((err as Error).message) + "\n");
    return 2;
  }
  if (taskSet.tasks.length === 0) {
    process.stderr.write(theme.err("No tasks matched.") + "\n");
    return 2;
  }

  const runs = Math.max(1, Math.floor(Number(opts.runs ?? 1)) || 1);
  const timeoutMs = Math.max(1000, Math.floor(Number(opts.timeout ?? 150_000)) || 150_000);
  const totalTaskRuns = arms.length * runs * taskSet.tasks.length;

  process.stdout.write(
    theme.brand("scissor benchmark") +
      theme.dim(
        ` · arms: ${arms.map((a) => a.id).join(", ")} · tasks: ${taskSet.name} (${taskSet.tasks.length})` +
          ` · N=${runs} · ${totalTaskRuns} task-runs\n`,
      ),
  );

  if (opts.dryRun) {
    process.stdout.write(theme.bold("\nPlan (dry run, nothing executed):\n"));
    for (const a of arms) {
      const price = priceFor(a.model);
      process.stdout.write(
        `  ${theme.brand(a.id.padEnd(22))} ${a.provider} · ${a.model}` +
          theme.dim(price ? `  ($${price.inputPer1M}/$${price.outputPer1M} per 1M)` : "  (unpriced)") +
          "\n",
      );
    }
    process.stdout.write(
      theme.dim(`\n  ${taskSet.tasks.length} tasks x ${runs} runs x ${arms.length} arms = ${totalTaskRuns} task-runs\n`),
    );
    return 0;
  }

  // Hold every non-model knob fixed across arms: the experience layer off, the
  // router off (so an arm is one named model, not a blend).
  const savedEnv: Record<string, string | undefined> = {};
  for (const k of EXP_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }

  const summaries: ArmSummary[] = [];
  try {
    for (const arm of arms) {
      process.stdout.write(theme.bold(`\n[${arm.id}] ${arm.provider} · ${arm.model}\n`));
      const iterations = [];
      for (let i = 0; i < runs; i++) {
        if (runs > 1) process.stdout.write(theme.dim(`  — run ${i + 1}/${runs} —\n`));
        const onProgress = (e: ProgressEvent): void => {
          if (e.type === "task-end") {
            const mark = e.result.pass ? theme.ok("\u2713") : theme.err("\u2717");
            process.stdout.write(
              `  ${mark} ${e.result.taskId} ${theme.dim(`(${e.result.turns}t)`)}\n`,
            );
          }
        };
        const providerRuns = await runEval({
          providers: [arm.provider as ProviderId],
          tasks: taskSet.tasks,
          model: arm.model,
          router: false,
          timeoutMs,
          onProgress,
        });
        iterations.push(providerRuns.flatMap((r) => r.results));
      }
      summaries.push(summarizeArm(arm, iterations));
    }
  } catch (err) {
    process.stderr.write(theme.err(`\nBenchmark aborted: ${(err as Error).message}\n`));
    return 1;
  } finally {
    for (const k of EXP_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k]!;
    }
  }

  const git = await gitProvenance();
  const provenance: BenchmarkProvenance = {
    taskSet: taskSet.name,
    taskIds: taskSet.tasks.map((t) => t.id),
    runsPerArm: runs,
    timeoutMs,
    harness: {
      router: false,
      experienceAdvice: false,
      experienceRouting: false,
      approvalPolicy: "auto",
    },
    scissorVersion: VERSION,
    ...git,
    nodeVersion: process.version.split(".")[0] ?? process.version,
    platform: process.platform,
    pricing: pricingFor(arms),
    pricingSource: PRICING_SOURCE,
  };

  const report = buildBenchmarkReport({ provenance, arms: summaries });
  const markdown = formatBenchmarkMarkdown(report);

  const outDir = path.resolve(opts.out ?? BENCHMARK_DIR);
  await fs.mkdir(outDir, { recursive: true });
  const base = `${taskSet.name.replace(/[^a-z0-9]+/gi, "-")}-n${runs}-${stamp(new Date())}`;
  const jsonPath = path.join(outDir, `${base}.json`);
  const mdPath = path.join(outDir, `${base}.md`);
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  await fs.writeFile(mdPath, markdown + "\n", "utf8");

  process.stdout.write("\n" + markdown + "\n");
  process.stdout.write(
    theme.ok(`\nWrote ${path.relative(process.cwd(), jsonPath)} and ${path.relative(process.cwd(), mdPath)}\n`),
  );
  if (report.leader && !report.leader.significant) {
    process.stdout.write(
      theme.warn("\nNote: the leading arm is not statistically separated. Raise --runs before quoting an ordering.\n"),
    );
  }
  return 0;
}
