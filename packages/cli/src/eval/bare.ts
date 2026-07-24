/**
 * "Bare" baseline target — a deliberately minimal agent harness, for measuring
 * how much scissor's scaffolding actually adds over a near-naked model call
 * (Databricks-style harness comparison; see OPEN_ITEMS §7d).
 *
 * It is intentionally missing everything scissor layers on: no repo-map, no
 * `retrieve`, no verification loop, no guardrails, no router, no memory, no
 * scratchpad, no clarification. It keeps only the four tools any harness needs
 * to touch a codebase (read / write / edit / shell) and a ~1-line system prompt
 * — a Pi-style minimal harness. Runs inside the same `runSuite` with identical
 * checks, holding the model fixed, so the only variable is the harness.
 *
 * In-process (not an external CLI) so it reports token usage for the cost side
 * of the comparison, and so it is deterministically testable with a mock
 * provider.
 */
import {
  Agent,
  applyEnvOverrides,
  createProvider,
  editFileTool,
  loadConfig,
  readFileTool,
  resolveModel,
  runShellTool,
  writeFileTool,
  type LLMProvider,
  type ProviderId,
} from "@scissor/core";
import type { AgentTarget } from "./runner.js";
import { trajectoryAccumulator, usageAccumulator } from "./runner.js";

const BARE_SYSTEM_PROMPT =
  "You are a coding assistant working in the current directory. Use the read, write, edit, " +
  "and shell tools to complete the user's task, then stop.";

export interface BareTargetOptions {
  provider?: ProviderId;
  /** Inject a provider directly (tests); when set, config is not loaded. */
  llm?: LLMProvider;
  /** Model label to attribute cost to (used with `llm`). */
  model?: string;
}

/** A minimal in-process harness target (four tools, tiny prompt, no scaffolding). */
export function bareTarget(opts: BareTargetOptions = {}): AgentTarget {
  return {
    label: "bare" + (opts.provider ? `:${opts.provider}` : ""),
    async runTask(task, workspaceRoot, timeoutMs) {
      let llm = opts.llm;
      let model = opts.model ?? "";
      if (!llm) {
        const config = applyEnvOverrides(await loadConfig());
        const providerId = opts.provider ?? config.defaultProvider;
        llm = createProvider(config, providerId);
        model = resolveModel(config, providerId);
      }

      const agent = new Agent({
        provider: llm,
        tools: [readFileTool, writeFileTool, editFileTool, runShellTool],
        workspaceRoot,
        approvalPolicy: "auto",
        systemPrompt: BARE_SYSTEM_PROMPT,
        autoCompact: false,
      });

      const usage = usageAccumulator();
      const traj = trajectoryAccumulator();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await agent.run(
          task.prompt,
          {
            onRequestApproval: async () => "approve" as const,
            onPresentPlan: async () => ({ action: "approve" as const }),
            onAskUser: async () => "proceed",
            onUsage: usage.onUsage,
            onToolEnd: traj.onToolEnd,
          },
          controller.signal,
        );
        return {
          finalText: res.finalText,
          turns: res.turns,
          model,
          ok: !res.aborted,
          detail: res.aborted ? "timed out" : undefined,
          promptTokens: usage.totals.promptTokens,
          completionTokens: usage.totals.completionTokens,
          toolCalls: traj.totals.toolCalls,
          inspectedFiles: traj.totals.files.size,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
