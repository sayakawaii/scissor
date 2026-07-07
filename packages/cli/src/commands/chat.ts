import { input } from "@inquirer/prompts";
import {
  loadSession,
  type ApprovalPolicy,
  type ProviderId,
  type SessionData,
} from "@scissor/core";
import {
  banner,
  createSession,
  friendlyError,
  makeCallbacks,
  persistSession,
  TurnRenderer,
  type Session,
} from "../session.js";
import { RESTART_EXIT_CODE } from "../self/repo.js";
import { theme } from "../ui/render.js";

export interface ChatOptions {
  provider?: ProviderId;
  approvalPolicy?: ApprovalPolicy;
  chatOnly?: boolean;
  /** Resume a saved session by id or file path. */
  resume?: string;
  /** Disable the automated verification closed-loop. */
  noVerify?: boolean;
  /** Enforce test-first (TDD) coding. */
  tdd?: boolean;
  /** Connect configured MCP servers. */
  mcp?: boolean;
}

async function resolveResume(resume?: string): Promise<SessionData | undefined> {
  if (!resume) return undefined;
  try {
    return await loadSession(resume);
  } catch (err) {
    process.stderr.write(theme.warn(`Could not load session "${resume}": ${(err as Error).message}\n`));
    return undefined;
  }
}

/** One-shot: run a single prompt and exit. */
export async function runOneShot(prompt: string, opts: ChatOptions): Promise<number> {
  let session: Session;
  try {
    session = await createSession({ ...opts, resume: await resolveResume(opts.resume) });
  } catch (err) {
    process.stderr.write(theme.err(friendlyError(err)) + "\n");
    return 1;
  }
  if (!session.data.goal) session.data.goal = prompt;

  const renderer = new TurnRenderer();
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);
  try {
    const result = await session.agent.run(prompt, makeCallbacks(renderer), controller.signal);
    renderer.finish();
    await persistSession(session).catch(() => {});
    if (result.aborted) {
      process.stdout.write(theme.warn("\nAborted.\n"));
      return 130;
    }
    return 0;
  } catch (err) {
    renderer.finish();
    process.stderr.write("\n" + theme.err(friendlyError(err)) + "\n");
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
    await session.mcp?.dispose().catch(() => {});
  }
}

/** Interactive REPL loop. */
export async function runRepl(opts: ChatOptions): Promise<number> {
  let session: Session;
  try {
    session = await createSession({ ...opts, resume: await resolveResume(opts.resume) });
  } catch (err) {
    process.stderr.write(theme.err(friendlyError(err)) + "\n");
    process.stderr.write(theme.dim("Run `scissor config` to set up an API key.\n"));
    return 1;
  }

  printHeader(session, false);
  return replLoop(session, { persist: true });
}

/**
 * Hidden supervised-agent mode: resume a session, run self-edit REPL, persist
 * after every turn, and exit with code 75 when a restart is requested so the
 * supervisor can verify + reload.
 */
export async function runAgentChild(sessionPath: string): Promise<number> {
  let resume: SessionData | undefined;
  try {
    resume = await loadSession(sessionPath);
  } catch {
    resume = undefined;
  }

  let session: Session;
  try {
    session = await createSession({ selfEdit: true, resume });
  } catch (err) {
    process.stderr.write(theme.err(friendlyError(err)) + "\n");
    return 1;
  }
  // Ensure the session id/path stays stable across restarts.
  if (resume) session.data = resume;

  printHeader(session, true);
  return replLoop(session, { persist: true, selfEdit: true });
}

interface LoopOptions {
  persist: boolean;
  selfEdit?: boolean;
}

async function replLoop(session: Session, loopOpts: LoopOptions): Promise<number> {
  try {
    return await replLoopInner(session, loopOpts);
  } finally {
    await session.mcp?.dispose().catch(() => {});
  }
}

async function replLoopInner(session: Session, loopOpts: LoopOptions): Promise<number> {
  for (;;) {
    let line: string;
    try {
      line = await input({ message: theme.user("you ›") });
    } catch {
      process.stdout.write("\n" + theme.dim("Bye.\n"));
      if (loopOpts.persist) await persistSession(session).catch(() => {});
      return 0;
    }
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    if (trimmed.startsWith("/")) {
      const done = await handleSlash(trimmed, session);
      if (done === "exit") {
        if (loopOpts.persist) await persistSession(session).catch(() => {});
        process.stdout.write(theme.dim("Bye.\n"));
        return 0;
      }
      continue;
    }

    const renderer = new TurnRenderer();
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.on("SIGINT", onSigint);
    try {
      const result = await session.agent.run(
        trimmed,
        makeCallbacks(renderer),
        controller.signal,
      );
      renderer.finish();
      if (loopOpts.persist) await persistSession(session).catch(() => {});

      if (result.restartRequested) {
        process.stdout.write(
          theme.brand(`\n[scissor] restart requested: ${result.restartRequested.reason}\n`),
        );
        process.stdout.write(theme.dim("Handing off to supervisor for verification...\n"));
        return RESTART_EXIT_CODE;
      }
      if (result.aborted) process.stdout.write(theme.warn("(interrupted)\n"));
    } catch (err) {
      renderer.finish();
      process.stderr.write("\n" + theme.err(friendlyError(err)) + "\n");
    } finally {
      process.off("SIGINT", onSigint);
    }
  }
}

function printHeader(session: Session, selfEdit: boolean): void {
  process.stdout.write(banner() + "\n");
  const modeTag = selfEdit
    ? theme.brand(` · self-edit (gen ${session.data.generation})`)
    : "";
  process.stdout.write(
    theme.dim(
      `provider: ${session.providerId} · model: ${session.model} · cwd: ${session.workspaceRoot}`,
    ) + modeTag + "\n",
  );
  process.stdout.write(theme.dim("Type your request. /help for commands, /exit to quit.\n"));
}

async function handleSlash(cmd: string, session: Session): Promise<"exit" | "continue"> {
  const [name] = cmd.slice(1).split(/\s+/);
  switch (name) {
    case "exit":
    case "quit":
    case "q":
      return "exit";
    case "reset":
      session.agent.reset();
      process.stdout.write(theme.ok("Conversation reset.\n"));
      return "continue";
    case "compact": {
      const renderer = new TurnRenderer();
      const did = await session.agent.compact({ onCompact: renderer.onCompact });
      renderer.finish();
      if (!did) process.stdout.write(theme.dim("Nothing to compact yet.\n"));
      await persistSession(session).catch(() => {});
      return "continue";
    }
    case "remember": {
      const fact = cmd.slice(1).replace(/^remember\s*/, "").trim();
      if (!fact) {
        process.stdout.write(theme.warn("Usage: /remember <fact to save>\n"));
        return "continue";
      }
      const renderer = new TurnRenderer();
      const result = await session.agent.runTool("remember", { fact }, makeCallbacks(renderer));
      renderer.finish();
      process.stdout.write((result.isError ? theme.err : theme.ok)(result.content) + "\n");
      return "continue";
    }
    case "help":
      process.stdout.write(
        [
          theme.bold("Commands:"),
          "  /help              show this help",
          "  /reset             clear conversation history",
          "  /compact           summarize the conversation so far to save context",
          "  /remember <fact>   save a durable fact to long-term memory",
          "  /info              show provider and workspace info",
          "  /exit              quit",
          "",
          theme.dim("Just type normally to talk to the agent."),
          "",
        ].join("\n"),
      );
      return "continue";
    case "info":
      process.stdout.write(
        theme.dim(
          `provider: ${session.providerId} · model: ${session.model} · cwd: ${session.workspaceRoot} · session: ${session.data.id}\n`,
        ),
      );
      return "continue";
    default:
      process.stdout.write(theme.warn(`Unknown command: ${cmd}. Try /help.\n`));
      return "continue";
  }
}
