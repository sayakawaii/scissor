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
