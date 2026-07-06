import { Command } from "commander";
import { PROVIDER_IDS, type ApprovalPolicy, type ProviderId } from "@scissor/core";
import { runOneShot, runRepl, type ChatOptions } from "./commands/chat.js";
import { runConfigWizard } from "./commands/config.js";
import { theme } from "./ui/render.js";

const VERSION = "0.1.0";

interface GlobalOpts {
  provider?: string;
  safe?: boolean;
  auto?: boolean;
  chatOnly?: boolean;
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

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(theme.err(String(err?.message ?? err)) + "\n");
  process.exit(1);
});
