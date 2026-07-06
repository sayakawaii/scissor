import { input } from "@inquirer/prompts";
import type { ApprovalPolicy, ProviderId } from "@scissor/core";
import {
  banner,
  createSession,
  friendlyError,
  makeCallbacks,
  TurnRenderer,
  type Session,
} from "../session.js";
import { theme } from "../ui/render.js";

export interface ChatOptions {
  provider?: ProviderId;
  approvalPolicy?: ApprovalPolicy;
  chatOnly?: boolean;
}

/** One-shot: run a single prompt and exit. */
export async function runOneShot(prompt: string, opts: ChatOptions): Promise<number> {
  let session: Session;
  try {
    session = await createSession(opts);
  } catch (err) {
    process.stderr.write(theme.err(friendlyError(err)) + "\n");
    return 1;
  }

  const renderer = new TurnRenderer();
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);
  try {
    const result = await session.agent.run(prompt, makeCallbacks(renderer), controller.signal);
    renderer.finish();
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
  }
}

/** Interactive REPL loop. */
export async function runRepl(opts: ChatOptions): Promise<number> {
  let session: Session;
  try {
    session = await createSession(opts);
  } catch (err) {
    process.stderr.write(theme.err(friendlyError(err)) + "\n");
    process.stderr.write(theme.dim("Run `scissor config` to set up an API key.\n"));
    return 1;
  }

  process.stdout.write(banner() + "\n");
  process.stdout.write(
    theme.dim(
      `provider: ${session.providerId} · model: ${session.model} · cwd: ${session.workspaceRoot}\n`,
    ),
  );
  process.stdout.write(theme.dim("Type your request. /help for commands, /exit to quit.\n"));

  for (;;) {
    let line: string;
    try {
      line = await input({ message: theme.user("you ›") });
    } catch {
      // Ctrl+C / Ctrl+D at the prompt.
      process.stdout.write("\n" + theme.dim("Bye.\n"));
      return 0;
    }
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    if (trimmed.startsWith("/")) {
      const done = handleSlash(trimmed, session);
      if (done === "exit") {
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
      if (result.aborted) process.stdout.write(theme.warn("(interrupted)\n"));
    } catch (err) {
      renderer.finish();
      process.stderr.write("\n" + theme.err(friendlyError(err)) + "\n");
    } finally {
      process.off("SIGINT", onSigint);
    }
  }
}

function handleSlash(cmd: string, session: Session): "exit" | "continue" {
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
    case "help":
      process.stdout.write(
        [
          theme.bold("Commands:"),
          "  /help          show this help",
          "  /reset         clear conversation history",
          "  /info          show provider and workspace info",
          "  /exit          quit",
          "",
          theme.dim("Just type normally to talk to the agent."),
          "",
        ].join("\n"),
      );
      return "continue";
    case "info":
      process.stdout.write(
        theme.dim(
          `provider: ${session.providerId} · model: ${session.model} · cwd: ${session.workspaceRoot}\n`,
        ),
      );
      return "continue";
    default:
      process.stdout.write(theme.warn(`Unknown command: ${cmd}. Try /help.\n`));
      return "continue";
  }
}
