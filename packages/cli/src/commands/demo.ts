/**
 * `scissor demo` — run a complete coding task end to end with no API key.
 *
 * The model's replies are scripted; everything else is the real product. The
 * agent loop, the plan gate, retrieval, the edit engine, the shell tool and the
 * guardrails all run exactly as they do in a live session, against a real
 * temporary workspace. The test genuinely fails before the fix and genuinely
 * passes after, because node really runs it.
 *
 * This is stated plainly on screen before and after the run. A replay that let
 * someone believe they had watched live inference would be worth less than no
 * demo at all, so the labelling is not decoration — it is the feature working
 * correctly.
 *
 * Deliberately never loads config and never reads an API key, so it cannot be a
 * path through which credentials leak.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Agent,
  createSandboxPolicy,
  defaultTools,
  ScriptedProvider,
  type AgentCallbacks,
  type ToolCall,
  type ToolResult,
} from "@scissor/core";
import {
  DEMO_SCRIPT,
  DEMO_TASK,
  DEMO_TEST_COMMAND,
  FIXED_MEDIAN,
  seedDemoWorkspace,
} from "../demo/scenario.js";
import { formatToolResult, theme, truncate } from "../ui/render.js";

export interface DemoCommandOptions {
  /** Run in this directory instead of a fresh temp one. */
  dir?: string;
  /** Keep the workspace afterwards instead of deleting it. */
  keep?: boolean;
  /** Where output goes. Injectable so the behaviour is testable. */
  out?: (text: string) => void;
}

export interface DemoResult {
  workspaceRoot: string;
  /** Names of the tools the agent actually invoked, in order. */
  toolsUsed: string[];
  turns: number;
  finalText: string;
  /** Source of the edited file after the run. */
  sourceAfter: string;
  /** Scripted turns consumed / available. */
  scriptTurns: { used: number; total: number };
  kept: boolean;
}

/** Shown before and after the run. Never let this be mistaken for live inference. */
const REPLAY_NOTICE =
  "REPLAY — the model's replies are pre-scripted and no network request is made. " +
  "Everything else is real: the agent loop, retrieval, the edit engine, the " +
  "guardrails and the shell all run, in a real temporary workspace.";

function header(out: (s: string) => void): void {
  out("\n" + theme.brand.bold("scissor demo") + "\n");
  out(theme.warn(REPLAY_NOTICE) + "\n\n");
}

/**
 * Run the scripted scenario. Exported separately from the command so tests can
 * drive it with a fixed directory and capture the output.
 */
export async function runDemo(opts: DemoCommandOptions = {}): Promise<DemoResult> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const workspaceRoot =
    opts.dir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "scissor-demo-")));
  const keep = opts.keep === true || opts.dir !== undefined;

  await fs.mkdir(workspaceRoot, { recursive: true });
  await seedDemoWorkspace(workspaceRoot);

  const provider = new ScriptedProvider({ script: DEMO_SCRIPT });
  const agent = new Agent({
    provider,
    tools: defaultTools(),
    workspaceRoot,
    // The plan is presented and auto-accepted below; tool calls do not stop for
    // confirmation, because there is nobody at the keyboard during a replay.
    approvalPolicy: "plan-gate",
    sandbox: createSandboxPolicy(workspaceRoot),
  });

  const toolsUsed: string[] = [];
  const callbacks: AgentCallbacks = {
    onPresentPlan: async (summary: string, steps: string[]) => {
      // present_plan is intercepted by the agent loop, so it never reaches
      // onToolStart; record it here to keep the trajectory complete.
      toolsUsed.push("present_plan");
      out(theme.bold("plan") + theme.dim(` · ${summary}`) + "\n");
      steps.forEach((s, i) => out(theme.dim(`  ${i + 1}. `) + s + "\n"));
      out(theme.ok("  (auto-approved for the replay)") + "\n\n");
      return { action: "approve" as const };
    },
    onRequestApproval: async () => "approve" as const,
    onAskUser: async () => "proceed",
    onToolStart: (c: ToolCall) => {
      toolsUsed.push(c.name);
      const arg =
        typeof c.arguments?.path === "string"
          ? c.arguments.path
          : typeof c.arguments?.command === "string"
            ? c.arguments.command
            : typeof c.arguments?.query === "string"
              ? c.arguments.query
              : "";
      out(theme.brand(`→ ${c.name}`) + (arg ? theme.dim(`  ${truncate(String(arg), 60)}`) : "") + "\n");
    },
    onToolEnd: (_c: ToolCall, r: ToolResult) => {
      out(formatToolResult(r) + "\n");
    },
    onAssistantText: (delta: string) => out(delta),
  };

  header(out);
  out(theme.dim(`workspace: ${workspaceRoot}`) + "\n");
  out(theme.bold("task") + theme.dim(` · ${DEMO_TASK}`) + "\n\n");

  const result = await agent.run(DEMO_TASK, callbacks);

  const sourceAfter = await fs.readFile(path.join(workspaceRoot, "src/stats.js"), "utf8");
  const fixed = sourceAfter.includes("sorted.length % 2 === 0");

  if (result.finalText.trim()) {
    out("\n" + theme.bold("summary") + "\n");
    out(result.finalText.trim() + "\n");
  }

  out("\n" + theme.bold("result") + "\n");
  out(
    `  ${fixed ? theme.ok("\u2713") : theme.err("\u2717")} src/stats.js ` +
      theme.dim(fixed ? "was edited by the edit engine" : "was not edited") +
      "\n",
  );
  out(
    `  ${theme.dim(`\`${DEMO_TEST_COMMAND}\` was run twice: once to reproduce the failure, once to confirm the fix`)}\n`,
  );
  out("\n" + theme.warn(REPLAY_NOTICE) + "\n");

  if (keep) {
    out(theme.dim(`\nWorkspace kept at ${workspaceRoot}\n`));
  } else {
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
  }

  return {
    workspaceRoot,
    toolsUsed,
    turns: result.turns,
    finalText: result.finalText,
    sourceAfter,
    scriptTurns: { used: provider.turnsUsed, total: provider.turnCount },
    kept: keep,
  };
}

/** Entry point for `scissor demo`. Returns a process exit code. */
export async function runDemoCommand(opts: DemoCommandOptions): Promise<number> {
  try {
    const result = await runDemo(opts);
    const ok = result.sourceAfter.includes(FIXED_MEDIAN.split("\n")[4]!.trim());
    if (!ok) {
      process.stderr.write(theme.err("\nDemo did not apply the expected edit.\n"));
      return 1;
    }
    process.stdout.write(
      theme.dim(
        "\nTo run scissor for real, add a provider key with `scissor config` and run `scissor \"<task>\"`.\n",
      ),
    );
    return 0;
  } catch (err) {
    process.stderr.write(theme.err(`\nDemo failed: ${(err as Error).message}\n`));
    return 1;
  }
}
