import { applyEnvOverrides, loadConfig, PROVIDER_IDS, type ProviderId } from "@scissor/core";
import { theme } from "../ui/render.js";
import { runEval, type ProgressEvent, type ProviderRun } from "../eval/runner.js";
import { resolveTasks } from "../eval/bench-tasks.js";
import { compareRuns, formatComparison } from "../eval/compare.js";
import { aggregateArm, formatRepeatedComparison } from "../eval/repeat.js";

export interface AbCommandOptions {
  provider?: string;
  task?: string;
  /** Which experience-layer policy to test as the candidate arm. */
  candidate?: string;
  /** Repeat each arm N times and report mean ± spread (default 1). */
  runs?: string;
  /** Exit non-zero if the candidate breaks any task. */
  strict?: boolean;
}

/** Env vars that select experience-layer behavior; controlled per arm. */
const EXP_ENV = [
  "SCISSOR_EXPERIENCE_ADVICE",
  "SCISSOR_EXPERIENCE_ROUTE",
] as const;

type CandidateKind = "advice" | "route" | "bare";

function parseList(v?: string): string[] | undefined {
  if (!v) return undefined;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

async function resolveProviders(spec?: string): Promise<ProviderId[]> {
  const config = applyEnvOverrides(await loadConfig());
  if (!spec) return [config.defaultProvider];
  const requested = parseList(spec) as ProviderId[];
  const invalid = requested.filter((p) => !(PROVIDER_IDS as string[]).includes(p));
  if (invalid.length > 0) {
    throw new Error(`Unknown provider(s): ${invalid.join(", ")}. Valid: ${PROVIDER_IDS.join(", ")}`);
  }
  return requested;
}

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of EXP_ENV) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of EXP_ENV) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function applyArm(candidate: "advice" | "route" | null): void {
  for (const k of EXP_ENV) delete process.env[k];
  if (candidate === "advice") process.env.SCISSOR_EXPERIENCE_ADVICE = "1";
  else if (candidate === "route") process.env.SCISSOR_EXPERIENCE_ROUTE = "enforce";
}

/** Relabel each run's provider to a canonical id so the two arms match by task. */
function relabel(runs: ProviderRun[], providers: ProviderId[]): ProviderRun[] {
  return runs.map((r, i) => ({ ...r, provider: String(providers[i] ?? r.provider) }));
}

const onProgress =
  (arm: string) =>
  (e: ProgressEvent): void => {
    if (e.type === "task-end") {
      const mark = e.result.pass ? theme.ok("\u2713") : theme.err("\u2717");
      process.stdout.write(`  [${arm}] ${mark} ${e.result.taskId}\n`);
    }
  };

/**
 * `scissor ab` — run the eval suite as two arms and report the difference in
 * pass rate AND per-task token/cost (Databricks-style; see OPEN_ITEMS §7d):
 *
 *  - `advice` / `route`: baseline = experience off, candidate = the policy on —
 *    the evidence gate before promoting advice/routing to enforce (doc §4/§5).
 *  - `bare`: baseline = the minimal `bare` harness, candidate = full scissor
 *    (router + experience off so the model is held fixed) — measures how much
 *    scissor's scaffolding adds over a near-naked model call.
 *
 * Under --strict, any newly broken task fails the command.
 */
export async function runAbCommand(opts: AbCommandOptions): Promise<number> {
  const candidate = (opts.candidate ?? "advice") as CandidateKind;
  if (candidate !== "advice" && candidate !== "route" && candidate !== "bare") {
    process.stderr.write(theme.err(`Unknown candidate "${candidate}". Use: advice | route | bare\n`));
    return 2;
  }

  let providers: ProviderId[];
  try {
    providers = await resolveProviders(opts.provider);
  } catch (err) {
    process.stderr.write(theme.err((err as Error).message) + "\n");
    return 2;
  }
  const taskIds = parseList(opts.task);
  const tasks = resolveTasks(taskIds);
  if (taskIds && tasks.length === 0) {
    process.stderr.write(theme.err(`No tasks matched: ${taskIds.join(", ")}\n`));
    return 2;
  }

  const runs = Math.max(1, Math.floor(Number(opts.runs ?? 1)) || 1);

  const candidateLabel =
    candidate === "advice" ? "advice-on" : candidate === "route" ? "route-enforce" : "scissor";
  const baselineLabel = candidate === "bare" ? "bare" : "baseline";
  process.stdout.write(
    theme.brand("scissor ab") +
      theme.dim(
        ` · ${providers.join(", ")} · tasks: ${taskIds?.join(", ") ?? "all"} · ${baselineLabel} vs ${candidateLabel}` +
          (runs > 1 ? ` · ${runs} runs` : "") +
          "\n",
      ),
  );

  // One iteration of each arm. Env is applied inside so it's correct per arm
  // and re-applied every iteration. Both arms hold the model fixed for `bare`.
  const runBaselineOnce = async (): Promise<ProviderRun[]> => {
    if (candidate === "bare") {
      applyArm(null);
      return relabel(await runEval({ providers, tasks, bare: true, onProgress: onProgress("bare") }), providers);
    }
    applyArm(null);
    return relabel(await runEval({ providers, tasks, onProgress: onProgress("base") }), providers);
  };
  const runCandidateOnce = async (): Promise<ProviderRun[]> => {
    if (candidate === "bare") {
      applyArm(null);
      return relabel(await runEval({ providers, tasks, router: false, onProgress: onProgress("scissor") }), providers);
    }
    applyArm(candidate);
    return relabel(await runEval({ providers, tasks, onProgress: onProgress("cand") }), providers);
  };

  const saved = snapshotEnv();
  const baseIters: ProviderRun[][] = [];
  const candIters: ProviderRun[][] = [];
  try {
    for (let i = 0; i < runs; i++) {
      if (runs > 1) process.stdout.write(theme.dim(`\n— run ${i + 1}/${runs} —`));
      process.stdout.write(theme.dim(`\nbaseline (${baselineLabel})…\n`));
      baseIters.push(await runBaselineOnce());
      process.stdout.write(theme.dim(`\ncandidate (${candidateLabel})…\n`));
      candIters.push(await runCandidateOnce());
    }
  } finally {
    restoreEnv(saved);
  }

  if (runs === 1) {
    const cmp = compareRuns(baseIters[0]!, candIters[0]!);
    process.stdout.write(
      "\n" +
        formatComparison(cmp, { baseline: baselineLabel, candidate: candidateLabel }, {
          bold: theme.bold,
          dim: theme.dim,
          ok: theme.ok,
          warn: theme.warn,
          err: theme.err,
        }) +
        "\n",
    );
    return opts.strict && cmp.broke.length > 0 ? 1 : 0;
  }

  const baseAgg = aggregateArm(baselineLabel, baseIters);
  const candAgg = aggregateArm(candidateLabel, candIters);
  process.stdout.write(
    "\n" +
      formatRepeatedComparison(baseAgg, candAgg, { baseline: baselineLabel, candidate: candidateLabel }, {
        bold: theme.bold,
        dim: theme.dim,
        ok: theme.ok,
        warn: theme.warn,
        err: theme.err,
      }) +
      "\n",
  );
  // Under --strict, fail if the candidate ever regressed a task that the
  // baseline always passed (a per-task pass-rate drop).
  const candById = new Map(candAgg.tasks.map((t) => [t.taskId, t]));
  const regressed = baseAgg.tasks.some((bt) => {
    const ct = candById.get(bt.taskId);
    return ct && bt.passes === bt.runs && ct.passes < ct.runs;
  });
  return opts.strict && regressed ? 1 : 0;
}
