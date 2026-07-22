import { applyEnvOverrides, loadConfig, PROVIDER_IDS, type ProviderId } from "@scissor/core";
import { theme } from "../ui/render.js";
import { runEval, type ProgressEvent, type ProviderRun } from "../eval/runner.js";
import { resolveTasks } from "../eval/bench-tasks.js";
import { buildAblation, formatAblation, type AblationArm } from "../eval/compare.js";

export interface AblateCommandOptions {
  provider?: string;
  task?: string;
  /** Exit non-zero if disabling any component improves pass rate (net-harmful scaffolding). */
  strict?: boolean;
}

/** Env vars toggled per arm; snapshotted/restored so runs don't leak state. */
const ABLATE_ENV = [
  "SCISSOR_NO_REPOMAP",
  "SCISSOR_NO_RETRIEVE",
  "SCISSOR_NO_VERIFY",
  "SCISSOR_NO_ROUTER",
  "SCISSOR_EXPERIENCE_ADVICE",
  "SCISSOR_EXPERIENCE_ROUTE",
] as const;

/** One component to ablate: a display name and the env that disables it. */
const ABLATIONS: { component: string; env: Record<string, string> }[] = [
  { component: "repo-map", env: { SCISSOR_NO_REPOMAP: "1" } },
  { component: "retrieve", env: { SCISSOR_NO_RETRIEVE: "1" } },
  { component: "verify-loop", env: { SCISSOR_NO_VERIFY: "1" } },
];

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
  for (const k of ABLATE_ENV) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ABLATE_ENV) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

/** Clear all ablation env, then apply an arm's overrides. */
function applyArm(env: Record<string, string>): void {
  for (const k of ABLATE_ENV) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}

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

/** Aggregate a reference run into a header summary (pass, tokens/task, cost/task). */
function summarize(runs: ProviderRun[]): {
  pass: number;
  total: number;
  tokensPerTask?: number;
  costPerTask?: number;
} {
  let pass = 0;
  let total = 0;
  let tokens = 0;
  let cost = 0;
  let tokensKnown = false;
  let costKnown = true;
  for (const run of runs) {
    for (const r of run.results) {
      total++;
      if (r.pass) pass++;
      if (r.promptTokens !== undefined || r.completionTokens !== undefined) {
        tokens += (r.promptTokens ?? 0) + (r.completionTokens ?? 0);
        tokensKnown = true;
      }
      if (r.costUsd !== undefined) cost += r.costUsd;
      else costKnown = false;
    }
  }
  const n = total || 1;
  return {
    pass,
    total,
    tokensPerTask: tokensKnown ? Math.round(tokens / n) : undefined,
    costPerTask: costKnown && total > 0 ? cost / n : undefined,
  };
}

/**
 * `scissor ablate` — measure what each of scissor's always-on scaffolding
 * components contributes, by running the eval suite once with everything on
 * (reference) and once per component with that component disabled, holding the
 * model fixed (router off). Reports a pass/token/cost matrix (OPEN_ITEMS §7d,
 * option C — the Databricks harness lesson applied inward). Under --strict,
 * exits non-zero if disabling any component *improves* pass rate.
 */
export async function runAblateCommand(opts: AblateCommandOptions): Promise<number> {
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

  process.stdout.write(
    theme.brand("scissor ablate") +
      theme.dim(
        ` · ${providers.join(", ")} · tasks: ${taskIds?.join(", ") ?? "all"} · components: ${ABLATIONS.map((a) => a.component).join(", ")}\n`,
      ),
  );

  const saved = snapshotEnv();
  let reference: ProviderRun[];
  const arms: AblationArm[] = [];
  try {
    process.stdout.write(theme.dim("\nreference (full scissor)…\n"));
    applyArm({}); // everything on; router forced off below for a fixed model
    reference = await runEval({ providers, tasks, router: false, onProgress: onProgress("full") });

    for (const ab of ABLATIONS) {
      process.stdout.write(theme.dim(`\nno ${ab.component}…\n`));
      applyArm(ab.env);
      const runs = await runEval({
        providers,
        tasks,
        router: false,
        onProgress: onProgress(`no-${ab.component}`),
      });
      arms.push({ component: ab.component, runs: relabel(runs, providers) });
    }
  } finally {
    restoreEnv(saved);
  }

  const ref = relabel(reference, providers);
  const rows = buildAblation(ref, arms);
  process.stdout.write(
    "\n" +
      formatAblation(summarize(ref), rows, {
        bold: theme.bold,
        dim: theme.dim,
        ok: theme.ok,
        warn: theme.warn,
        err: theme.err,
      }) +
      "\n",
  );

  return opts.strict && rows.some((r) => r.passDelta > 0) ? 1 : 0;
}
