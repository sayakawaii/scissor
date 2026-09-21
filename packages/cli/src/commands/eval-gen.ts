import { promises as fs } from "node:fs";
import path from "node:path";
import { getConfigDir } from "@scissor/core";
import { theme } from "../ui/render.js";
import { generateEvalDraft } from "../eval-gen.js";
import { latestTraceFile, readTraceFile } from "../trace-report.js";

export interface EvalGenOptions {
  out?: string;
  id?: string;
  print?: boolean;
}

function tracesDir(): string {
  return path.join(getConfigDir(), "traces");
}

/**
 * `scissor eval-gen [idOrPath]` — turn a traced session into a draft regression
 * eval case. Defaults to the most recent trace.
 */
export async function runEvalGenCommand(
  target: string | undefined,
  opts: EvalGenOptions,
): Promise<number> {
  const dir = tracesDir();
  let file: string | undefined;
  if (target) {
    file = target.endsWith(".jsonl") ? target : path.join(dir, `${target}.jsonl`);
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

  const draft = generateEvalDraft(events, { id: opts.id });
  if (!draft.prompt) {
    process.stderr.write(
      theme.warn(
        "This trace has no recorded user prompt (older trace?). Re-run with --trace to capture one.\n",
      ),
    );
    return 1;
  }

  if (opts.print) {
    process.stdout.write(draft.code);
    return 0;
  }

  const outPath = opts.out
    ? path.resolve(opts.out)
    : path.join(process.cwd(), "evals", "generated", draft.filename);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, draft.code, "utf8");

  process.stdout.write(theme.ok(`Draft eval case written to ${outPath}\n`));
  process.stdout.write(
    theme.dim(
      `  id: ${draft.id}\n  files asserted: ${draft.files.length ? draft.files.join(", ") : "(none — tighten the check!)"}\n`,
    ),
  );
  process.stdout.write(
    theme.dim("  Review & tighten the check, then move it into eval/bench-tasks.\n"),
  );
  return 0;
}
