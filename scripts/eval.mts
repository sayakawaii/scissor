/**
 * Run the scissor eval suite against a real provider and print a scored report.
 * A thin wrapper over the CLI eval command so `npm run eval` works via tsx.
 *
 * Examples:
 *   node --import tsx scripts/eval.mts
 *   node --import tsx scripts/eval.mts --task edit-json,fix-bug
 *   node --import tsx scripts/eval.mts --provider all --json evals/last-run.json
 */
import { runEvalCommand, type EvalCommandOptions } from "../packages/cli/src/commands/eval.js";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

const opts: EvalCommandOptions = {
  provider: argValue("--provider") ?? argValue("-p"),
  task: argValue("--task") ?? argValue("-t"),
  json: argValue("--json"),
  keep: hasFlag("--keep"),
  list: hasFlag("--list"),
  strict: hasFlag("--strict"),
};

const code = await runEvalCommand(opts);
process.exit(code);
