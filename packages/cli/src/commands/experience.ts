import path from "node:path";
import {
  adviseOptions,
  curateOptions,
  filterFailingStats,
  formatAdvice,
  formatCuration,
  formatExperienceReport,
  getConfigDir,
} from "@scissor/core";
import { theme } from "../ui/render.js";
import { experienceReportFromDir, experienceReportFromFile } from "../experience-report.js";
import { snapshotWorkspaceState } from "../session.js";

export interface ExperienceCommandOptions {
  json?: boolean;
  minSamples?: string;
  advise?: boolean;
  curate?: boolean;
  fail?: string;
}

function tracesDir(): string {
  return path.join(getConfigDir(), "traces");
}

/**
 * `scissor experience [idOrPath]` — offline OaK-inspired option-utility report
 * (doc §8). With no argument, aggregates ALL traces in ~/.scissor/traces so the
 * report reflects cross-session experience; pass a session id or path to scope
 * it to one run. This is observe-only: it never changes agent behavior.
 */
export async function runExperienceCommand(
  target: string | undefined,
  opts: ExperienceCommandOptions,
): Promise<number> {
  const dir = tracesDir();
  const minSamples = opts.minSamples ? Number.parseInt(opts.minSamples, 10) : undefined;
  const aggOpts =
    minSamples !== undefined && Number.isFinite(minSamples) && minSamples > 0
      ? { minSamples }
      : {};

  let report;
  try {
    if (target) {
      const file = target.endsWith(".jsonl") ? target : path.join(dir, `${target}.jsonl`);
      report = await experienceReportFromFile(file, aggOpts);
    } else {
      report = await experienceReportFromDir(dir, aggOpts);
    }
  } catch {
    process.stderr.write(
      theme.err(`Could not read traces from ${dir}. Run a session with --trace first.\n`),
    );
    return 1;
  }

  // --fail <rate> filter: only keep cells below the threshold, flakiest first.
  // Applied before advise/curate so the filtered report is used.
  if (opts.fail !== undefined) {
    const rate = Number.parseFloat(opts.fail);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      process.stderr.write(theme.err(`--fail expects a fraction between 0 and 1, got "${opts.fail}"\n`));
      return 1;
    }
    report = filterFailingStats(report, rate);
  }

  // Advisory view: rank options by learned reliability for the CURRENT workspace
  // state (doc §5 Phase 3). Read-only; this does not change agent behavior.
  if (opts.advise) {
    const state = await snapshotWorkspaceState(process.cwd(), {
      approvalPolicy: "plan-gate",
      tdd: false,
    });
    const advice = adviseOptions(report, { state });
    if (opts.json) {
      process.stdout.write(JSON.stringify({ state, advice }, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(theme.dim(`traces: ${dir}\n\n`));
    process.stdout.write(
      formatAdvice(advice, state, {
        bold: theme.bold,
        dim: theme.dim,
        ok: theme.ok,
        warn: theme.warn,
      }) + "\n",
    );
    return 0;
  }

  // Curation view: read-only capability suggestions (doc §5 Phase 5). Never
  // applies anything.
  if (opts.curate) {
    const recs = curateOptions(report);
    if (opts.json) {
      process.stdout.write(JSON.stringify(recs, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(theme.dim(`traces: ${dir}\n\n`));
    process.stdout.write(
      formatCuration(recs, {
        bold: theme.bold,
        dim: theme.dim,
        ok: theme.ok,
        warn: theme.warn,
        err: theme.err,
      }) + "\n",
    );
    return 0;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(theme.dim(`traces: ${dir}\n\n`));
  process.stdout.write(
    formatExperienceReport(report, {
      bold: theme.bold,
      dim: theme.dim,
      ok: theme.ok,
      warn: theme.warn,
    }) + "\n",
  );
  return 0;
}
