import { applyEnvOverrides, loadConfig, PROVIDER_IDS, type ProviderId } from "@scissor/core";
import { theme } from "../ui/render.js";
import { runEval, type ProgressEvent, type ProviderRun } from "../eval/runner.js";
import { compareRuns, formatComparison } from "../eval/compare.js";

export interface AbCommandOptions {
  provider?: string;
  task?: string;
  /** Which experience-layer policy to test as the candidate arm. */
  candidate?: string;
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

  const candidateLabel =
    candidate === "advice" ? "advice-on" : candidate === "route" ? "route-enforce" : "scissor";
  const baselineLabel = candidate === "bare" ? "bare" : "baseline";
  process.stdout.write(
    theme.brand("scissor ab") +
      theme.dim(
        ` · ${providers.join(", ")} · tasks: ${taskIds?.join(", ") ?? "all"} · ${baselineLabel} vs ${candidateLabel}\n`,
      ),
  );

  const saved = snapshotEnv();
  let baseline: ProviderRun[];
  let candidateRuns: ProviderRun[];
  try {
    if (candidate === "bare") {
      // Hold the model fixed: experience + router off in both arms.
      applyArm(null);
      process.stdout.write(theme.dim("\nbaseline (bare minimal harness)…\n"));
      baseline = await runEval({ providers, taskIds, bare: true, onProgress: onProgress("bare") });
      process.stdout.write(theme.dim("\ncandidate (full scissor)…\n"));
      candidateRuns = await runEval({
        providers,
        taskIds,
        router: false,
        onProgress: onProgress("scissor"),
      });
    } else {
      process.stdout.write(theme.dim("\nbaseline (experience off)…\n"));
      applyArm(null);
      baseline = await runEval({ providers, taskIds, onProgress: onProgress("base") });
      process.stdout.write(theme.dim(`\ncandidate (${candidateLabel})…\n`));
      applyArm(candidate);
      candidateRuns = await runEval({ providers, taskIds, onProgress: onProgress("cand") });
    }
  } finally {
    restoreEnv(saved);
  }

  const cmp = compareRuns(relabel(baseline, providers), relabel(candidateRuns, providers));
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
