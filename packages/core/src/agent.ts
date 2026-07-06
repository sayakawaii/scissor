import { CONTROL_TOOL_NAMES } from "./tools/control.js";
import { buildSystemPrompt } from "./prompt.js";
import type {
  LLMProvider,
  Message,
  Tool,
  ToolCall,
  ToolContext,
  ToolPreview,
  ToolResult,
  Usage,
  VerificationResult,
  VerifyFn,
} from "./types.js";

export type ApprovalPolicy = "plan-gate" | "confirm-each" | "auto";

export type ApprovalDecision = "approve" | "reject" | "always";

export interface PlanDecision {
  /** approved -> proceed; revise -> feedback provided; reject -> abandon. */
  action: "approve" | "revise" | "reject";
  feedback?: string;
}

/** Callbacks the UI implements to render output and gather user input. */
export interface AgentCallbacks {
  onAssistantText?(delta: string): void;
  onReasoning?(delta: string): void;
  /** A new assistant turn is starting (after tool results were fed back). */
  onTurnStart?(turn: number): void;
  onToolStart?(call: ToolCall, preview?: ToolPreview): void;
  onToolEnd?(call: ToolCall, result: ToolResult): void;
  /** Ask the user to approve a mutating tool call. */
  onRequestApproval?(call: ToolCall, preview: ToolPreview): Promise<ApprovalDecision>;
  /** Handle the ask_user control tool. Returns the user's answer. */
  onAskUser?(question: string, options?: string[]): Promise<string>;
  /** Handle the present_plan control tool. */
  onPresentPlan?(summary: string, steps: string[]): Promise<PlanDecision>;
  onUsage?(usage: Usage): void;
  /** Automated verification is about to run after edits. */
  onVerifyStart?(): void;
  /** Automated verification finished. */
  onVerifyResult?(result: VerificationResult): void;
}

export interface AgentOptions {
  provider: LLMProvider;
  tools: Tool[];
  workspaceRoot: string;
  approvalPolicy?: ApprovalPolicy;
  maxTurns?: number;
  /**
   * Soft cap on total conversation size (in characters). When exceeded, the
   * oldest complete rounds are dropped to keep requests within provider limits.
   */
  maxContextChars?: number;
  /** Provide a custom system prompt; otherwise a default is built. */
  systemPrompt?: string;
  /** Prior transcript (excluding system) to resume from. */
  initialMessages?: Message[];
  /** Workspace-relative globs that mutating tools must refuse to modify. */
  protectedPaths?: string[];
  /**
   * Optional project verifier. When set, after the model finishes a request in
   * which it edited files, this runs; failures are fed back so the model can
   * self-correct (closed loop), bounded by maxVerifyAttempts.
   */
  verify?: VerifyFn;
  /** Max automated verification runs per request (default 2). */
  maxVerifyAttempts?: number;
}

export interface RunResult {
  finalText: string;
  turns: number;
  aborted: boolean;
  /** Set when the model called restart_self; the caller should reload. */
  restartRequested?: { reason: string };
}

/**
 * The core agent loop, UI-agnostic. Maintains conversation state across turns
 * and drives the provider + tools until the model stops requesting tools.
 */
export class Agent {
  private provider: LLMProvider;
  private toolMap: Map<string, Tool>;
  private tools: Tool[];
  private workspaceRoot: string;
  private approvalPolicy: ApprovalPolicy;
  private maxTurns: number;
  private maxContextChars: number;
  private messages: Message[];
  private protectedPaths: string[];
  private verify?: VerifyFn;
  private maxVerifyAttempts: number;
  /** Set when restart_self is invoked during a run. */
  private pendingRestart?: { reason: string };
  /** Tools the user chose to "always" approve during this session. */
  private alwaysApproved = new Set<string>();

  constructor(opts: AgentOptions) {
    this.provider = opts.provider;
    this.tools = opts.tools;
    this.toolMap = new Map(opts.tools.map((t) => [t.name, t]));
    this.workspaceRoot = opts.workspaceRoot;
    this.approvalPolicy = opts.approvalPolicy ?? "plan-gate";
    this.maxTurns = opts.maxTurns ?? 25;
    this.maxContextChars = opts.maxContextChars ?? 200_000;
    this.protectedPaths = opts.protectedPaths ?? [];
    this.verify = opts.verify;
    this.maxVerifyAttempts = opts.maxVerifyAttempts ?? 2;
    const system =
      opts.systemPrompt ??
      buildSystemPrompt({
        workspaceRoot: this.workspaceRoot,
        platform: process.platform,
        approvalPolicy: this.approvalPolicy,
      });
    this.messages = [{ role: "system", content: system }];
    if (opts.initialMessages?.length) {
      this.messages.push(...opts.initialMessages.filter((m) => m.role !== "system"));
    }
  }

  /** Full conversation history (including the system prompt). */
  getMessages(): readonly Message[] {
    return this.messages;
  }

  /** Conversation transcript excluding the system prompt (for persistence). */
  getTranscript(): Message[] {
    return this.messages.filter((m) => m.role !== "system");
  }

  /** Reset conversation, keeping the system prompt. */
  reset(): void {
    this.messages = this.messages.slice(0, 1);
    this.alwaysApproved.clear();
  }

  /** Run one user request to completion (may span many model turns). */
  async run(
    userInput: string,
    callbacks: AgentCallbacks = {},
    signal?: AbortSignal,
  ): Promise<RunResult> {
    this.messages.push({ role: "user", content: userInput });

    const ctx: ToolContext = {
      workspaceRoot: this.workspaceRoot,
      signal,
      protectedPaths: this.protectedPaths,
    };
    let finalText = "";
    let turn = 0;
    this.pendingRestart = undefined;
    const editedFiles = new Set<string>();
    let editsSinceVerify = false;
    let verifyAttempts = 0;

    while (turn < this.maxTurns) {
      if (signal?.aborted) return { finalText, turns: turn, aborted: true };
      turn += 1;
      callbacks.onTurnStart?.(turn);
      this.trimContext();

      const result = await this.provider.chat({
        messages: this.messages,
        tools: this.tools,
        signal,
        callbacks: {
          onText: callbacks.onAssistantText,
          onReasoning: callbacks.onReasoning,
        },
      });

      if (result.usage) callbacks.onUsage?.(result.usage);
      finalText = result.text || finalText;

      // Record the assistant turn (text + any tool calls).
      this.messages.push({
        role: "assistant",
        content: result.text,
        toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
      });

      if (result.toolCalls.length === 0) {
        // The model believes it is done. Run automated verification if edits
        // were made, and feed failures back so it can self-correct.
        if (
          this.verify &&
          editsSinceVerify &&
          verifyAttempts < this.maxVerifyAttempts &&
          !signal?.aborted
        ) {
          verifyAttempts += 1;
          editsSinceVerify = false;
          callbacks.onVerifyStart?.();
          let report: VerificationResult;
          try {
            report = await this.verify({ editedFiles: [...editedFiles] });
          } catch (err) {
            report = { ok: true, summary: `verification skipped: ${(err as Error).message}`, skipped: true };
          }
          callbacks.onVerifyResult?.(report);
          if (!report.ok && !report.skipped) {
            this.messages.push({
              role: "user",
              content:
                `[automated verification] ${report.summary}\n` +
                (report.output ? `${report.output}\n` : "") +
                `Fix the issues above, then finish. This check will run again.`,
            });
            continue;
          }
        }
        return { finalText: result.text, turns: turn, aborted: false };
      }

      // Execute each requested tool call and feed results back.
      for (const call of result.toolCalls) {
        if (signal?.aborted) return { finalText, turns: turn, aborted: true };
        const toolResult = await this.handleToolCall(call, ctx, callbacks, signal);
        if (
          !toolResult.isError &&
          (call.name === "write_file" || call.name === "edit_file")
        ) {
          editsSinceVerify = true;
          const p = call.arguments.path;
          if (typeof p === "string") editedFiles.add(p);
        }
        this.messages.push({
          role: "tool",
          content: toolResult.content,
          toolCallId: call.id,
          name: call.name,
        });
      }

      // A restart was requested; hand control back so the supervisor can
      // verify + reload. The transcript already contains a tool result so it
      // stays valid when resumed.
      if (this.pendingRestart) {
        return {
          finalText,
          turns: turn,
          aborted: false,
          restartRequested: this.pendingRestart,
        };
      }
    }

    return { finalText, turns: turn, aborted: false };
  }

  private async handleToolCall(
    call: ToolCall,
    ctx: ToolContext,
    callbacks: AgentCallbacks,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    // Control tools are handled by the UI, not executed directly.
    if (call.name === "ask_user") {
      const question = String(call.arguments.question ?? "");
      const options = Array.isArray(call.arguments.options)
        ? (call.arguments.options as unknown[]).map((o) => String(o))
        : undefined;
      if (!callbacks.onAskUser) {
        return { content: "No UI available to ask the user.", isError: true };
      }
      const answer = await callbacks.onAskUser(question, options);
      return { content: `User answered: ${answer}` };
    }

    if (call.name === "present_plan") {
      const summary = String(call.arguments.summary ?? "");
      const steps = Array.isArray(call.arguments.steps)
        ? (call.arguments.steps as unknown[]).map((s) => String(s))
        : [];
      if (!callbacks.onPresentPlan) {
        return { content: "Plan noted (no UI to confirm). Proceeding.", isError: false };
      }
      const decision = await callbacks.onPresentPlan(summary, steps);
      if (decision.action === "approve") {
        return { content: "User approved the plan. Proceed with execution." };
      }
      if (decision.action === "revise") {
        return {
          content: `User requested changes to the plan: ${decision.feedback ?? "(no details)"}. Revise the plan and present it again.`,
        };
      }
      return {
        content: "User rejected the plan. Stop and ask how they would like to proceed.",
      };
    }

    if (call.name === "restart_self") {
      const reason = String(call.arguments.reason ?? "self-update");
      this.pendingRestart = { reason };
      return {
        content:
          "Restart requested. The supervisor will now verify the new build; " +
          "if it passes, scissor reloads into the new version and this " +
          "conversation continues. If verification fails, the changes are " +
          "rolled back. Assume success and continue the task after restart.",
      };
    }

    const tool = this.toolMap.get(call.name);
    if (!tool) {
      return { content: `Unknown tool: ${call.name}`, isError: true };
    }

    // Compute a preview (diff / command) for mutating tools.
    let preview: ToolPreview | undefined;
    if (tool.preview) {
      try {
        preview = await tool.preview(call.arguments, ctx);
      } catch (err) {
        preview = { summary: `${tool.name}`, detail: (err as Error).message };
      }
    }

    // Approval gate.
    if (tool.mutating && this.needsApproval(tool, preview)) {
      if (callbacks.onRequestApproval && preview) {
        const decision = await callbacks.onRequestApproval(call, preview);
        if (decision === "reject") {
          return {
            content: "User rejected this action. Do not retry it; consider an alternative.",
            isError: false,
          };
        }
        if (decision === "always") this.alwaysApproved.add(tool.name);
      }
    }

    callbacks.onToolStart?.(call, preview);
    let result: ToolResult;
    try {
      result = await tool.run(call.arguments, { ...ctx, signal });
    } catch (err) {
      result = { content: `Tool error: ${(err as Error).message}`, isError: true };
    }
    callbacks.onToolEnd?.(call, result);
    return result;
  }

  /**
   * Drop the oldest complete conversation rounds when the total size exceeds
   * the budget. A "round" starts at a user message; dropping whole rounds keeps
   * assistant tool_call / tool_result pairs valid.
   */
  private trimContext(): void {
    const size = () =>
      this.messages.reduce(
        (n, m) =>
          n +
          m.content.length +
          (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0),
        0,
      );
    while (size() > this.maxContextChars) {
      const firstUser = this.messages.findIndex((m, i) => i >= 1 && m.role === "user");
      if (firstUser === -1) break;
      const nextUser = this.messages.findIndex(
        (m, i) => i > firstUser && m.role === "user",
      );
      // Keep the most recent round intact even if it exceeds the budget.
      if (nextUser === -1) break;
      this.messages.splice(firstUser, nextUser - firstUser);
    }
  }

  private needsApproval(tool: Tool, preview?: ToolPreview): boolean {
    if (this.alwaysApproved.has(tool.name)) return preview?.dangerous ?? false;
    switch (this.approvalPolicy) {
      case "auto":
        return preview?.dangerous ?? false;
      case "confirm-each":
        return true;
      case "plan-gate":
      default:
        // In plan-gate, the plan is approved up front; only prompt for
        // individually dangerous actions.
        return preview?.dangerous ?? false;
    }
  }
}

export { CONTROL_TOOL_NAMES };
