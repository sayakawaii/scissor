/**
 * `scissor demo` — run a complete coding task end to end with no API key.
 *
 * The model's replies are scripted; everything else is the real product. The
 * agent loop, the plan gate, retrieval, the edit engine, the command classifier,
 * the approval gate and the shell all run exactly as they do in a live session,
 * against a real temporary workspace.
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
  classifyCommand,
  createSandboxPolicy,
  defaultTools,
  ScriptedProvider,
  type AgentCallbacks,
  type ToolCall,
  type ToolResult,
} from "@scissor/core";
import {
  DEFAULT_SCENARIO_ID,
  getScenario,
  SCENARIOS,
  seedDemoWorkspace,
  type DemoScenario,
} from "../demo/scenario.js";
import { formatToolResult, theme, truncate } from "../ui/render.js";

export interface DemoCommandOptions {
  /** Scenario id; defaults to `fix-bug`. */
  scenario?: string;
  /** List the available scenarios and exit. */
  list?: boolean;
  /** Run in this directory instead of a fresh temp one. */
  dir?: string;
  /** Keep the workspace afterwards instead of deleting it. */
  keep?: boolean;
  /** Where output goes. Injectable so the behaviour is testable. */
  out?: (text: string) => void;
}

export interface DemoResult {
  scenarioId: string;
  workspaceRoot: string;
  /** Names of the tools the agent actually invoked, in order. */
  toolsUsed: string[];
  /** Tool calls the guardrail pipeline or the tool itself refused. */
  blocked: { command: string; message: string }[];
  /** Commands the replay was asked to approve, and what it answered. */
  approvals: { command: string; decision: string }[];
  turns: number;
  finalText: string;
  /** Scripted turns consumed / available. */
  scriptTurns: { used: number; total: number };
  /** Each scenario outcome, checked against the real filesystem. */
  outcomes: { label: string; ok: boolean }[];
  kept: boolean;
}

/** Shown before and after the run. Never let this be mistaken for live inference. */
const REPLAY_NOTICE =
  "REPLAY — the model's replies are pre-scripted and no network request is made. " +
  "Everything else is real: the agent loop, retrieval, the edit engine, the " +
  "command classifier and the shell all run, in a real temporary workspace.";

/**
 * Refuse to start unless the real safety layer still returns the verdicts the
 * scenario is built around.
 *
 * A scenario that wants to show a refusal has to put the refused command in the
 * script, so the only safe way to hold it is to make the demo fail closed: if
 * the classifier ever stopped denying it, we abort rather than hand it to a
 * shell. This is also what makes the demo honest — the refusal a judge sees is
 * produced by `classifyCommand`, and this check proves it, because a scripted
 * refusal would sail past it.
 */
export function assertSafetyLayerIntact(scenario: DemoScenario): void {
  for (const expected of scenario.expectedVerdicts ?? []) {
    const verdict = classifyCommand(expected.command);
    if (verdict.kind !== expected.kind || ("rule" in verdict && verdict.rule) !== expected.rule) {
      throw new Error(
        `Refusing to run the "${scenario.id}" scenario: the command classifier no longer ` +
          `returns ${expected.kind}/${expected.rule} for ${JSON.stringify(expected.command)} ` +
          `(got ${verdict.kind}/${"rule" in verdict ? verdict.rule : "-"}). ` +
          `The scenario depends on that refusal, so it will not be run.`,
      );
    }
  }
}

/** Render the list shown by `--list`. */
export function formatScenarioList(): string {
  const rows = SCENARIOS.map((s) => {
    const mark = s.id === DEFAULT_SCENARIO_ID ? theme.dim(" (default)") : "";
    return `  ${theme.brand(s.id.padEnd(9))} ${s.title}${mark}\n      ${theme.dim(s.shows)}`;
  });
  return (
    theme.bold("Available demo scenarios") +
    "\n\n" +
    rows.join("\n\n") +
    "\n\n" +
    theme.dim("Run one with `scissor demo --scenario <id>`.\n")
  );
}

/**
 * Run a scripted scenario. Exported separately from the command so tests can
 * drive it with a fixed directory and capture the output.
 */
export async function runDemo(opts: DemoCommandOptions = {}): Promise<DemoResult> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const scenarioId = opts.scenario ?? DEFAULT_SCENARIO_ID;
  const scenario = getScenario(scenarioId);
  if (!scenario) {
    throw new Error(
      `Unknown demo scenario "${scenarioId}". Available: ${SCENARIOS.map((s) => s.id).join(", ")}.`,
    );
  }
  assertSafetyLayerIntact(scenario);

  const workspaceRoot =
    opts.dir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "scissor-demo-")));
  const keep = opts.keep === true || opts.dir !== undefined;

  await fs.mkdir(workspaceRoot, { recursive: true });
  await seedDemoWorkspace(workspaceRoot, scenario);

  const provider = new ScriptedProvider({ script: scenario.script });
  const agent = new Agent({
    provider,
    tools: defaultTools(),
    workspaceRoot,
    // The plan is presented and auto-accepted below; individually dangerous
    // calls still reach the approval gate, which is the point of the safety
    // scenario.
    approvalPolicy: "plan-gate",
    sandbox: createSandboxPolicy(workspaceRoot),
  });

  const toolsUsed: string[] = [];
  const blocked: { command: string; message: string }[] = [];
  const approvals: { command: string; decision: string }[] = [];
  const pendingApproval: string[] = [];

  const argOf = (c: ToolCall): string => {
    for (const key of ["command", "path", "query"]) {
      const v = c.arguments?.[key];
      if (typeof v === "string") return v;
    }
    return "";
  };

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
    // The approval gate runs inside the guardrail pipeline, which is before
    // onToolStart, so writing here directly would print the prompt above the
    // call it belongs to. Buffer and flush once the header is out.
    onRequestApproval: async (call: ToolCall, preview) => {
      const command = argOf(call);
      const decision = scenario.decide?.(call) ?? "approve";
      approvals.push({ command, decision });
      const reason = preview.detail?.match(/\(([^)]*)\)\s*$/)?.[1] ?? preview.summary;
      pendingApproval.push(theme.warn("  ! approval required") + theme.dim(` — ${reason}`));
      pendingApproval.push(
        decision === "reject"
          ? theme.err("  ✗ declined for the replay") +
              theme.dim(" — it does more than the task asked for")
          : theme.ok("  ✓ approved for the replay"),
      );
      return decision;
    },
    onAskUser: async () => "proceed",
    onToolStart: (c: ToolCall) => {
      toolsUsed.push(c.name);
      const arg = argOf(c);
      out(theme.brand(`→ ${c.name}`) + (arg ? theme.dim(`  ${truncate(arg, 70)}`) : "") + "\n");
      for (const line of pendingApproval.splice(0)) out(line + "\n");
    },
    onToolEnd: (c: ToolCall, r: ToolResult) => {
      // A refusal is the thing worth reading in full — the one-line summary
      // would hide the reason and the "do not retry" instruction that make it a
      // dead end rather than a failure. A rejection is not flagged isError (it
      // is a decision, not a fault), so match on the text either way.
      const refusal = /^Refusing to run this command/.test(r.content);
      const rejected = /^User rejected this action/.test(r.content);
      if (refusal || rejected) {
        blocked.push({ command: argOf(c), message: r.content });
        out(
          (refusal
            ? theme.err("  ✗ refused by the command classifier — not approvable")
            : theme.err("  ✗ not run — the approval was declined")) + "\n",
        );
        for (const line of r.content.split("\n")) out(theme.dim(`      ${line}`) + "\n");
        return;
      }
      out(formatToolResult(r) + "\n");
    },
    onAssistantText: (delta: string) => out(delta),
  };

  out("\n" + theme.brand.bold("scissor demo") + theme.dim(` · ${scenario.id}`) + "\n");
  out(theme.warn(REPLAY_NOTICE) + "\n\n");
  out(theme.dim(`shows: ${scenario.shows}`) + "\n");
  out(theme.dim(`workspace: ${workspaceRoot}`) + "\n");
  out(theme.bold("task") + theme.dim(` · ${scenario.task}`) + "\n\n");

  const result = await agent.run(scenario.task, callbacks);

  if (result.finalText.trim()) {
    out("\n" + theme.bold("summary") + "\n");
    out(result.finalText.trim() + "\n");
  }

  const outcomes: { label: string; ok: boolean }[] = [];
  for (const outcome of scenario.outcomes) {
    outcomes.push({ label: outcome.label, ok: await outcome.check(workspaceRoot) });
  }

  out("\n" + theme.bold("result") + theme.dim(" (checked against the workspace)") + "\n");
  for (const o of outcomes) {
    out(`  ${o.ok ? theme.ok("✓") : theme.err("✗")} ${theme.dim(o.label)}\n`);
  }
  out("\n" + theme.warn(REPLAY_NOTICE) + "\n");

  if (keep) {
    out(theme.dim(`\nWorkspace kept at ${workspaceRoot}\n`));
  } else {
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
  }

  return {
    scenarioId: scenario.id,
    workspaceRoot,
    toolsUsed,
    blocked,
    approvals,
    turns: result.turns,
    finalText: result.finalText,
    scriptTurns: { used: provider.turnsUsed, total: provider.turnCount },
    outcomes,
    kept: keep,
  };
}

/** Entry point for `scissor demo`. Returns a process exit code. */
export async function runDemoCommand(opts: DemoCommandOptions): Promise<number> {
  if (opts.list) {
    process.stdout.write("\n" + formatScenarioList());
    return 0;
  }
  try {
    const result = await runDemo(opts);
    const failed = result.outcomes.filter((o) => !o.ok);
    if (failed.length > 0) {
      process.stderr.write(
        theme.err(`\nDemo did not reach its expected outcome: ${failed[0]!.label}\n`),
      );
      return 1;
    }
    const others = SCENARIOS.filter((s) => s.id !== result.scenarioId).map((s) => s.id);
    if (others.length > 0) {
      process.stdout.write(
        theme.dim(`\nAnother scenario: \`scissor demo --scenario ${others[0]}\` (--list for all).\n`),
      );
    }
    process.stdout.write(
      theme.dim(
        "To run scissor for real, add a provider key with `scissor config` and run `scissor \"<task>\"`.\n",
      ),
    );
    return 0;
  } catch (err) {
    process.stderr.write(theme.err(`\nDemo failed: ${(err as Error).message}\n`));
    return 1;
  }
}
