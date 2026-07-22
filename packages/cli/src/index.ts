import { Command } from "commander";
import {
  getSessionPath,
  listSessions,
  PROVIDER_IDS,
  type ApprovalPolicy,
  type ProviderId,
} from "@scissor/core";
import {
  runAgentChild,
  runOneShot,
  runRepl,
  type ChatOptions,
} from "./commands/chat.js";
import { runConfigWizard } from "./commands/config.js";
import { runEvalCommand } from "./commands/eval.js";
import { buildMcpCommand } from "./commands/mcp.js";
import { createSession, persistSession } from "./session.js";
import { getScissorRepoRoot } from "./self/repo.js";
import { runSupervisor } from "./self/supervisor.js";
import { theme } from "./ui/render.js";

const VERSION = "0.2.0";

interface GlobalOpts {
  provider?: string;
  safe?: boolean;
  auto?: boolean;
  chatOnly?: boolean;
  resume?: string;
  /** commander sets this to false when --no-verify is passed. */
  verify?: boolean;
  /** commander sets this to false when --no-mcp is passed. */
  mcp?: boolean;
  /** Enforce test-first (TDD) coding. */
  tdd?: boolean;
  /** Lead clearly ambiguous requests with a clarifying question. */
  clarify?: boolean;
  /** Enable the heuristic model router. */
  router?: boolean;
  /** Write a structured JSONL trace of the session. */
  trace?: boolean;
}

function resolveProvider(value: string | undefined): ProviderId | undefined {
  if (!value) return undefined;
  if ((PROVIDER_IDS as string[]).includes(value)) return value as ProviderId;
  process.stderr.write(
    theme.err(`Unknown provider "${value}". Valid: ${PROVIDER_IDS.join(", ")}\n`),
  );
  process.exit(2);
}

function resolvePolicy(opts: GlobalOpts): ApprovalPolicy {
  if (opts.safe) return "confirm-each";
  if (opts.auto) return "auto";
  return "plan-gate";
}

function toChatOptions(opts: GlobalOpts): ChatOptions {
  return {
    provider: resolveProvider(opts.provider),
    approvalPolicy: resolvePolicy(opts),
    chatOnly: opts.chatOnly,
    resume: opts.resume,
    noVerify: opts.verify === false,
    // undefined when the flag is absent, so config.tddMode can still enable it.
    tdd: opts.tdd === true ? true : undefined,
    // undefined when absent, so config.clarifyIntent can still enable it.
    clarify: opts.clarify === true ? true : undefined,
    mcp: opts.mcp !== false,
    // undefined when absent, so config.router.enabled can still enable it.
    router: opts.router === true ? true : undefined,
    trace: opts.trace === true ? true : undefined,
  };
}

const program = new Command();

program
  .name("scissor")
  .description("A personal Cursor-like terminal AI coding agent")
  .version(VERSION, "-v, --version", "output the version number")
  .option("-p, --provider <id>", `provider to use (${PROVIDER_IDS.join(", ")})`)
  .option("--safe", "confirm every file change and command before running")
  .option("--auto", "run everything automatically (only confirm dangerous actions)")
  .option("--chat-only", "disable file edits and command execution")
  .option("--no-verify", "disable the automated verification closed-loop")
  .option("--no-mcp", "do not connect configured MCP servers this session")
  .option("--tdd", "enforce test-first coding (block source edits until a test exists)")
  .option("--clarify", "force intent-clarification on every request (default: auto-detect vague ones)")
  .option("--router", "force cheap/strong model routing (default: auto when a strong-tier key exists; SCISSOR_NO_ROUTER=1 to disable)")
  .option("--trace", "write a session trace (default: on; SCISSOR_NO_TRACE=1 to disable, SCISSOR_TRACE_KEEP=N to cap retention)")
  .option("--resume <id>", "resume a saved session by id or file path")
  .argument("[prompt...]", "prompt to run once, then exit (omit for interactive mode)")
  .action(async (promptParts: string[], opts: GlobalOpts) => {
    const chatOptions = toChatOptions(opts);
    const prompt = promptParts.join(" ").trim();
    const code = prompt.length > 0
      ? await runOneShot(prompt, chatOptions)
      : await runRepl(chatOptions);
    process.exit(code);
  });

program
  .command("config")
  .description("configure API keys and default provider")
  .action(async () => {
    await runConfigWizard();
    process.exit(0);
  });

program
  .command("chat")
  .description("start the interactive REPL (same as running with no prompt)")
  .action(async () => {
    const code = await runRepl(toChatOptions(program.opts<GlobalOpts>()));
    process.exit(code);
  });

program
  .command("sessions")
  .description("list saved sessions")
  .action(async () => {
    const sessions = await listSessions();
    if (sessions.length === 0) {
      process.stdout.write(theme.dim("No saved sessions.\n"));
    } else {
      for (const s of sessions) {
        process.stdout.write(
          `${theme.brand(s.id)}  ${theme.dim(s.updatedAt)}  ${theme.dim(`(${s.provider}, gen ${s.generation})`)}\n` +
            (s.goal ? `  ${theme.dim(s.goal.slice(0, 100))}\n` : ""),
        );
      }
    }
    process.exit(0);
  });

program
  .command("eval")
  .description("run the eval suite (repeatable tasks scored automatically)")
  .option("-p, --provider <ids>", 'comma-separated providers, or "all" for every configured one')
  .option("-t, --task <ids>", "comma-separated task ids to run (default: all)")
  .option("--json <path>", "write results JSON to a file")
  .option("--keep", "keep temp workspaces for inspection")
  .option("--strict", "exit non-zero if any task fails")
  .option("--router", "run scissor with the heuristic model router enabled")
  .option("--list", "list available tasks and exit")
  .action(async (opts) => {
    const code = await runEvalCommand(opts);
    process.exit(code);
  });

program
  .command("bench")
  .description("run the harder benchmark suite against scissor, goose, or a custom agent")
  .option("-a, --agent <name>", "agent to benchmark: scissor (default), goose, or custom")
  .option("--agent-cmd <template>", 'for --agent custom: e.g. "mytool run -t {PROMPT}"')
  .option("-p, --provider <ids>", 'for scissor: comma-separated providers, or "all"')
  .option("-t, --task <ids>", "comma-separated task ids to run (default: all)")
  .option("--json <path>", "write results JSON to a file")
  .option("--keep", "keep temp workspaces for inspection")
  .option("--strict", "exit non-zero if any task fails")
  .option("--list", "list available benchmark tasks and exit")
  .action(async (opts) => {
    const { runBenchCommand } = await import("./commands/bench.js");
    const code = await runBenchCommand(opts);
    process.exit(code);
  });

program.addCommand(buildMcpCommand());

program
  .command("trace [idOrPath]")
  .description("aggregate a session trace into a token/cost report (default: latest)")
  .option("--json", "print the report as JSON")
  .option("--list", "list available trace files and exit")
  .action(async (target: string | undefined, opts: { json?: boolean; list?: boolean }) => {
    const { runTraceCommand } = await import("./commands/trace.js");
    process.exit(await runTraceCommand(target, opts));
  });

program
  .command("experience [idOrPath]")
  .description(
    "offline option-utility report from session traces (default: all traces)",
  )
  .option("--json", "print the report as JSON")
  .option("--min-samples <n>", "min samples before a stat is trusted (default 5)")
  .option("--advise", "rank options by learned reliability for the current workspace")
  .option("--curate", "suggest keep/promote/demote/archive/disable actions (nothing applied)")
  .option("--fail <rate>", "only show cells with successRate below this fraction (0-1), flakiest first")
  .action(
    async (
      target: string | undefined,
      opts: { json?: boolean; minSamples?: string; advise?: boolean; curate?: boolean; fail?: string },
    ) => {
      const { runExperienceCommand } = await import("./commands/experience.js");
      process.exit(await runExperienceCommand(target, opts));
    },
  );

program
  .command("ab")
  .description("A/B the eval suite: baseline (experience off) vs a candidate policy")
  .option("-p, --provider <ids>", "comma-separated providers (default: configured default)")
  .option("-t, --task <ids>", "comma-separated task ids to run (default: all)")
  .option("--candidate <kind>", "candidate: advice | route | bare (default: advice; bare = scissor vs minimal harness)")
  .option("--runs <n>", "repeat each arm N times and report mean ± spread (default: 1)")
  .option("--strict", "exit non-zero if the candidate breaks any task")
  .action(async (opts) => {
    const { runAbCommand } = await import("./commands/ab.js");
    process.exit(await runAbCommand(opts));
  });

program
  .command("ablate")
  .description("ablation matrix: full scissor vs each scaffolding component disabled (pass/token/cost)")
  .option("-p, --provider <ids>", "comma-separated providers (default: configured default)")
  .option("-t, --task <ids>", "comma-separated task ids to run (default: all)")
  .option("--strict", "exit non-zero if disabling any component improves pass rate")
  .action(async (opts) => {
    const { runAblateCommand } = await import("./commands/ablate.js");
    process.exit(await runAblateCommand(opts));
  });

program
  .command("eval-gen [idOrPath]")
  .description("generate a draft regression eval case from a session trace (default: latest)")
  .option("--out <path>", "write the draft to this file")
  .option("--id <id>", "override the generated task id")
  .option("--print", "print the draft to stdout instead of writing a file")
  .action(async (target: string | undefined, opts: { out?: string; id?: string; print?: boolean }) => {
    const { runEvalGenCommand } = await import("./commands/eval-gen.js");
    process.exit(await runEvalGenCommand(target, opts));
  });

program
  .command("supervise")
  .description(
    "run scissor under a supervisor so it can safely edit and reload its own code",
  )
  .argument("[goal...]", "optional description of the self-improvement goal")
  .action(async (goalParts: string[]) => {
    const repo = getScissorRepoRoot();
    let session;
    try {
      session = await createSession({ selfEdit: true, workspaceRoot: repo });
    } catch (err) {
      process.stderr.write(theme.err(String((err as Error).message)) + "\n");
      process.exit(1);
      return;
    }
    const goal = goalParts.join(" ").trim();
    if (goal) session.data.goal = goal;
    await persistSession(session);
    const sessionPath = getSessionPath(session.data.id);

    process.stdout.write(
      theme.brand("scissor supervisor") +
        theme.dim(` · repo: ${repo} · session: ${session.data.id}\n`),
    );
    const code = await runSupervisor({ repo, sessionPath });
    process.exit(code);
  });

// Hidden: the supervised agent child process.
program
  .command("__agent", { hidden: true })
  .requiredOption("--session <path>", "session file to resume")
  .option("--self-edit", "run in self-edit mode")
  .action(async (opts: { session: string }) => {
    const code = await runAgentChild(opts.session);
    process.exit(code);
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(theme.err(String(err?.message ?? err)) + "\n");
  process.exit(1);
});
