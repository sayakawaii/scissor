/**
 * Run the harder benchmark suite and print a scored report. Thin wrapper over
 * the CLI bench command so `npm run bench` works via tsx.
 *
 * Examples:
 *   node --import tsx scripts/bench.mts                       # scissor (default provider)
 *   node --import tsx scripts/bench.mts --agent goose         # goose (must be on PATH + configured)
 *   node --import tsx scripts/bench.mts --agent custom --agent-cmd "mytool run -t {PROMPT}"
 *   node --import tsx scripts/bench.mts --task fibonacci-cli,csv-sum --json evals/bench.json
 */
import { runBenchCommand, type BenchCommandOptions } from "../packages/cli/src/commands/bench.js";

function argValue(...flags: string[]): string | undefined {
  for (const flag of flags) {
    const i = process.argv.indexOf(flag);
    if (i !== -1) return process.argv[i + 1];
  }
  return undefined;
}
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

const opts: BenchCommandOptions = {
  agent: argValue("--agent", "-a"),
  agentCmd: argValue("--agent-cmd"),
  provider: argValue("--provider", "-p"),
  task: argValue("--task", "-t"),
  json: argValue("--json"),
  keep: hasFlag("--keep"),
  list: hasFlag("--list"),
  strict: hasFlag("--strict"),
};

const code = await runBenchCommand(opts);
process.exit(code);
