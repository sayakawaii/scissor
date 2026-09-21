import path from "node:path";
import { getConfigDir } from "@scissor/core";
import { theme } from "../ui/render.js";
import {
  aggregateTrace,
  formatTraceReport,
  latestTraceFile,
  readTraceFile,
} from "../trace-report.js";

export interface TraceCommandOptions {
  json?: boolean;
  list?: boolean;
}

function tracesDir(): string {
  return path.join(getConfigDir(), "traces");
}

/**
 * `scissor trace [idOrPath]` — aggregate a session trace into a token/cost
 * report. With no argument, uses the most recent trace file.
 */
export async function runTraceCommand(
  target: string | undefined,
  opts: TraceCommandOptions,
): Promise<number> {
  const dir = tracesDir();

  if (opts.list) {
    const { promises: fs } = await import("node:fs");
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    const jsonl = entries.filter((f) => f.endsWith(".jsonl"));
    if (jsonl.length === 0) {
      process.stdout.write(theme.dim(`No traces in ${dir}. Run with --trace to create one.\n`));
      return 0;
    }
    process.stdout.write(theme.bold(`Traces in ${dir}:\n`));
    for (const f of jsonl.sort()) process.stdout.write(`  ${f.replace(/\.jsonl$/, "")}\n`);
    return 0;
  }

  // Resolve the trace file: explicit path, session id, or latest.
  let file: string | undefined;
  if (target) {
    if (target.endsWith(".jsonl")) file = target;
    else file = path.join(dir, `${target}.jsonl`);
  } else {
    file = await latestTraceFile(dir);
    if (!file) {
      process.stderr.write(
        theme.err(`No traces found in ${dir}. Run a session with --trace first.\n`),
      );
      return 1;
    }
  }

  let events;
  try {
    events = await readTraceFile(file);
  } catch {
    process.stderr.write(theme.err(`Could not read trace file: ${file}\n`));
    return 1;
  }
  if (events.length === 0) {
    process.stderr.write(theme.err(`Trace file is empty or malformed: ${file}\n`));
    return 1;
  }

  const report = aggregateTrace(events);

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(theme.dim(`trace: ${file}\n\n`));
  process.stdout.write(
    formatTraceReport(report, {
      bold: theme.bold,
      dim: theme.dim,
      ok: theme.ok,
      warn: theme.warn,
    }) + "\n",
  );
  return 0;
}
