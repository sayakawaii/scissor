import { CONTROL_TOOL_NAMES } from "./tools/control.js";
import { buildSystemPrompt } from "./prompt.js";
import { createApprovalGuard, createTddGuard } from "./guardrails.js";
import type {
  ApprovalDecision,
  ApprovalPolicy,
  GuardContext,
  Guardrail,
  LLMProvider,
  Message,
  Scratchpad,
  Tool,
  ToolCall,
  ToolContext,
  ToolPreview,
  ToolResult,
  Usage,
  VerificationResult,
  VerifyFn,
} from "./types.js";

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
  /** Conversation history was compacted into a summary. */
  onCompact?(info: CompactionInfo): void;
  /** A sub-agent was spawned to handle a delegated task. */
  onSubagentStart?(task: string, depth: number): void;
  /** A sub-agent finished; summary is its final message. */
  onSubagentEnd?(summary: string, depth: number): void;
}

export interface CompactionInfo {
  /** Number of messages folded into the summary. */
  summarizedMessages: number;
  /** Approx. characters before and after compaction. */
  beforeChars: number;
  afterChars: number;
}

/**
 * Summarizes a slice of conversation into compact prose. Provided for tests;
 * otherwise the agent summarizes with its own provider.
 */
export type SummarizeFn = (messages: Message[]) => Promise<string>;

const SUMMARY_MARKER = "[Summary of earlier conversation]";
const COMPACT_REQUEST = "(Earlier conversation was summarized to save context.)";

const SUBAGENT_PREAMBLE =
  "\n\n[Sub-agent mode]\n" +
  "You are a focused sub-agent handling ONE delegated sub-task. You cannot see " +
  "the parent conversation, so rely only on the task description and the " +
  "workspace. Work autonomously — you cannot ask the user. When finished, end " +
  "your final message with a concise summary of what you did, which files you " +
  "changed, and any findings the parent agent needs to continue.";

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
  /**
   * When the conversation grows past this many characters, the oldest rounds are
   * summarized into a compact note instead of being dropped. Defaults to 70% of
   * maxContextChars. Set autoCompact:false to disable.
   */
  compactThreshold?: number;
  autoCompact?: boolean;
  /** Custom summarizer (defaults to summarizing via the provider). */
  summarize?: SummarizeFn;
  /** Workspace-relative file used by the `remember` tool for long-term memory. */
  memoryFile?: string;
  /**
   * Test-first (TDD) mode. When true, the agent refuses to write/edit a
   * non-test source file until at least one test file has been created or
   * edited this session, nudging a red-green-refactor workflow.
   */
  tddMode?: boolean;
  /**
   * Initial working-memory scratchpad (e.g. restored from a resumed session).
   * The agent maintains it via the update_scratchpad tool and pins it into the
   * system prompt so it survives compaction and restarts.
   */
  initialScratchpad?: Scratchpad;
  /** Nesting depth of this agent (0 = top-level; children are 1, ...). Internal. */
  subagentDepth?: number;
  /** Max sub-agent nesting depth allowed (default 1: children cannot spawn). */
  maxSubagentDepth?: number;
  /**
   * Guardrails run around every real tool call: they can veto a call before it
   * runs and inspect/transform its result afterward. Run in array order.
   */
  guardrails?: Guardrail[];
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
  private autoCompact: boolean;
  private compactThreshold: number;
  private summarize: SummarizeFn;
  private memoryFile?: string;
  private subagentDepth: number;
  private maxSubagentDepth: number;
  /**
   * The effective guardrail chain run around every real tool call: built-in
   * TDD (when enabled) + user guardrails + the approval guard, in that order.
   */
  private guardrails: Guardrail[];
  /** System prompt without the dynamic scratchpad block appended. */
  private baseSystemPrompt: string;
  /** Structured working memory, pinned into the system prompt. */
  private scratchpad: Scratchpad;
  /** Set when restart_self is invoked during a run. */
  private pendingRestart?: { reason: string };

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
    this.autoCompact = opts.autoCompact ?? true;
    this.compactThreshold = opts.compactThreshold ?? Math.floor(this.maxContextChars * 0.7);
    this.summarize = opts.summarize ?? ((msgs) => this.summarizeWithProvider(msgs));
    this.memoryFile = opts.memoryFile;
    this.subagentDepth = opts.subagentDepth ?? 0;
    this.maxSubagentDepth = opts.maxSubagentDepth ?? 1;
    // Unified lifecycle-hook chain: TDD gate (if enabled) runs first, then any
    // user-supplied guardrails (e.g. oscillation), and finally the approval
    // gate so we only prompt for calls that passed the earlier policy checks.
    this.guardrails = [
      ...(opts.tddMode ? [createTddGuard()] : []),
      ...(opts.guardrails ?? []),
      createApprovalGuard(),
    ];
    this.baseSystemPrompt =
      opts.systemPrompt ??
      buildSystemPrompt({
        workspaceRoot: this.workspaceRoot,
        platform: process.platform,
        approvalPolicy: this.approvalPolicy,
      });
    this.scratchpad = opts.initialScratchpad ? { ...opts.initialScratchpad } : {};
    this.messages = [{ role: "system", content: this.renderSystemPrompt() }];
    if (opts.initialMessages?.length) {
      this.messages.push(...opts.initialMessages.filter((m) => m.role !== "system"));
    }
  }

  /** System prompt = base prompt + the pinned scratchpad block (if enabled). */
  private renderSystemPrompt(): string {
    if (!this.toolMap.has("update_scratchpad")) return this.baseSystemPrompt;
    return this.baseSystemPrompt + renderScratchpadBlock(this.scratchpad);
  }

  /** Re-render messages[0] after the scratchpad changes. */
  private syncSystemPrompt(): void {
    if (this.messages[0]?.role === "system") {
      this.messages[0].content = this.renderSystemPrompt();
    }
  }

  /** Merge a partial scratchpad update (from the update_scratchpad tool). */
  private applyScratchpadUpdate(args: Record<string, unknown>): void {
    const s = this.scratchpad;
    if (typeof args.goal === "string") s.goal = args.goal.trim() || undefined;
    if (typeof args.next_step === "string") s.nextStep = args.next_step.trim() || undefined;
    if (typeof args.last_error === "string") s.lastError = args.last_error.trim() || undefined;
    if (Array.isArray(args.files)) {
      s.files = (args.files as unknown[]).map((f) => String(f).trim()).filter(Boolean);
    }
    if (args.clear_notes === true) s.notes = [];
    if (typeof args.note === "string" && args.note.trim()) {
      (s.notes ??= []).push(args.note.trim());
    }
    this.syncSystemPrompt();
  }

  /** Current working-memory scratchpad (for persistence). */
  getScratchpad(): Scratchpad {
    return this.scratchpad;
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
    for (const guard of this.guardrails) guard.reset?.();
    this.scratchpad = {};
    this.syncSystemPrompt();
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
      memoryFile: this.memoryFile,
    };
    let finalText = "";
    let turn = 0;
    this.pendingRestart = undefined;
    const editedFiles = new Set<string>();
    let editsSinceVerify = false;
    let verifyAttempts = 0;
    let compactionFailed = false;

    while (turn < this.maxTurns) {
      if (signal?.aborted) return { finalText, turns: turn, aborted: true };
      turn += 1;
      callbacks.onTurnStart?.(turn);
      if (this.autoCompact && !compactionFailed && this.contextSize() > this.compactThreshold) {
        const ok = await this.compactOldest(callbacks, signal);
        if (!ok) compactionFailed = true;
      }
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

      // Execute the requested tool calls and feed results back. Independent
      // read-only calls (non-mutating, non-control) run concurrently; mutating
      // and control calls run sequentially in order so approval prompts and
      // side effects stay deterministic. Results are always pushed in the
      // original call order to keep the transcript valid.
      const calls = result.toolCalls;
      const results = new Array<ToolResult | undefined>(calls.length);

      const parallel = calls
        .map((call, i) => ({ call, i }))
        .filter(({ call }) => this.isParallelSafe(call));
      if (parallel.length > 1) {
        await Promise.all(
          parallel.map(async ({ call, i }) => {
            results[i] = await this.handleToolCall(call, ctx, callbacks, signal);
          }),
        );
      } else if (parallel.length === 1) {
        const { call, i } = parallel[0]!;
        results[i] = await this.handleToolCall(call, ctx, callbacks, signal);
      }

      let aborted = false;
      for (let i = 0; i < calls.length; i++) {
        if (results[i] !== undefined) continue; // already ran in the parallel phase
        if (signal?.aborted) {
          aborted = true;
          break;
        }
        results[i] = await this.handleToolCall(calls[i]!, ctx, callbacks, signal);
      }

      // Record results in order: track edits and push tool messages.
      for (let i = 0; i < calls.length; i++) {
        const toolResult = results[i];
        if (toolResult === undefined) continue;
        const call = calls[i]!;
        if (
          !toolResult.isError &&
          (call.name === "write_file" || call.name === "edit_file")
        ) {
          editsSinceVerify = true;
          const p = call.arguments.path;
          if (typeof p === "string") editedFiles.add(p);
        }
        // A sub-agent may have edited files; verify after delegation too.
        if (!toolResult.isError && call.name === "spawn_subagent") {
          editsSinceVerify = true;
        }
        this.messages.push({
          role: "tool",
          content: toolResult.content,
          toolCallId: call.id,
          name: call.name,
        });
      }

      if (aborted) return { finalText, turns: turn, aborted: true };

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

  /**
   * Execute a single tool directly (e.g. from a slash command), with the normal
   * approval gate. Does not add anything to the conversation transcript.
   */
  async runTool(
    name: string,
    args: Record<string, unknown>,
    callbacks: AgentCallbacks = {},
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const ctx: ToolContext = {
      workspaceRoot: this.workspaceRoot,
      signal,
      protectedPaths: this.protectedPaths,
      memoryFile: this.memoryFile,
    };
    const call: ToolCall = { id: `manual-${Date.now()}`, name, arguments: args };
    return this.handleToolCall(call, ctx, callbacks, signal);
  }

  /**
   * A tool call is safe to run concurrently with others in the same turn when it
   * is a known, non-mutating, non-control tool: read-only tools have no side
   * effects and don't depend on each other, so their order doesn't matter.
   */
  private isParallelSafe(call: ToolCall): boolean {
    if ((CONTROL_TOOL_NAMES as readonly string[]).includes(call.name)) return false;
    const tool = this.toolMap.get(call.name);
    return !!tool && tool.mutating !== true;
  }

  /**
   * Run a delegated sub-task in a fresh child Agent with its own clean context
   * but the same provider, workspace, and worker tools. Only the child's final
   * summary is returned to the parent, keeping the parent's context focused.
   */
  private async runSubagent(
    task: string,
    callbacks: AgentCallbacks,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (this.subagentDepth >= this.maxSubagentDepth) {
      return {
        content:
          "Sub-agents cannot spawn further sub-agents. Do this sub-task yourself.",
        isError: true,
      };
    }
    // Worker tools: drop control tools (no plans/questions/restart/nested spawn).
    const controlNames = CONTROL_TOOL_NAMES as readonly string[];
    const workerTools = this.tools.filter((t) => !controlNames.includes(t.name));

    const child = new Agent({
      provider: this.provider,
      tools: workerTools,
      workspaceRoot: this.workspaceRoot,
      approvalPolicy: this.approvalPolicy,
      protectedPaths: this.protectedPaths,
      systemPrompt: this.baseSystemPrompt + SUBAGENT_PREAMBLE,
      maxTurns: this.maxTurns,
      maxContextChars: this.maxContextChars,
      autoCompact: this.autoCompact,
      summarize: this.summarize,
      memoryFile: this.memoryFile,
      subagentDepth: this.subagentDepth + 1,
      maxSubagentDepth: this.maxSubagentDepth,
      guardrails: this.guardrails,
    });

    callbacks.onSubagentStart?.(task, this.subagentDepth + 1);
    let res;
    try {
      res = await child.run(task, callbacks, signal);
    } catch (err) {
      return { content: `Sub-agent failed: ${(err as Error).message}`, isError: true };
    }
    callbacks.onSubagentEnd?.(res.finalText, this.subagentDepth + 1);
    if (res.aborted) {
      return { content: "Sub-agent was interrupted before finishing.", isError: true };
    }
    return {
      content:
        `Sub-agent finished (${res.turns} turns). Summary:\n` +
        (res.finalText.trim() || "(the sub-agent returned no summary)"),
    };
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

    if (call.name === "update_scratchpad") {
      this.applyScratchpadUpdate(call.arguments);
      const state = renderScratchpadState(this.scratchpad);
      return { content: `Working memory updated.\n${state}` };
    }

    if (call.name === "spawn_subagent") {
      const task = String(call.arguments.task ?? "").trim();
      if (!task) return { content: "Error: 'task' is required.", isError: true };
      return this.runSubagent(task, callbacks, signal);
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

    // Unified guardrail pipeline (before): TDD gate, user guards (oscillation,
    // etc.), and the approval gate all run here as lifecycle hooks. A veto
    // blocks the call and is fed back to the model.
    const gctx: GuardContext = {
      tool,
      preview,
      ctx,
      policy: this.approvalPolicy,
      signal,
      requestApproval: callbacks.onRequestApproval,
    };
    for (const guard of this.guardrails) {
      if (!guard.beforeTool) continue;
      const verdict = await guard.beforeTool(call, gctx);
      if (!verdict.allow) {
        const blocked: ToolResult = verdict.result ?? {
          content: `Blocked by guardrail "${guard.name}": ${verdict.reason}`,
          isError: true,
        };
        callbacks.onToolStart?.(call, preview);
        callbacks.onToolEnd?.(call, blocked);
        return blocked;
      }
    }

    callbacks.onToolStart?.(call, preview);
    let result: ToolResult;
    try {
      result = await tool.run(call.arguments, { ...ctx, signal });
    } catch (err) {
      result = { content: `Tool error: ${(err as Error).message}`, isError: true };
    }
    // Guardrail pipeline (after): let guards inspect/transform the result.
    for (const guard of this.guardrails) {
      if (!guard.afterTool) continue;
      const transformed = await guard.afterTool(call, result);
      if (transformed) result = transformed;
    }
    callbacks.onToolEnd?.(call, result);
    return result;
  }

  /** Approximate character size of the whole conversation. */
  private contextSize(): number {
    return this.messages.reduce(
      (n, m) =>
        n + m.content.length + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0),
      0,
    );
  }

  /**
   * Manually compact the conversation: summarize everything except the most
   * recent round into a note. Returns true if anything was compacted.
   */
  async compact(callbacks: AgentCallbacks = {}, signal?: AbortSignal): Promise<boolean> {
    const lastRoundStart = this.lastUserRoundStart();
    if (lastRoundStart <= 1) return false;
    return this.compactRange(1, lastRoundStart, callbacks, signal);
  }

  /** Auto-compaction: fold old rounds, keeping a recent window intact. */
  private async compactOldest(callbacks: AgentCallbacks, signal?: AbortSignal): Promise<boolean> {
    const keepChars = Math.floor(this.maxContextChars * 0.5);
    // Walk backwards to a round boundary once we've kept ~keepChars recent.
    let acc = 0;
    let splitIndex = this.messages.length;
    for (let i = this.messages.length - 1; i >= 1; i--) {
      const m = this.messages[i]!;
      acc += m.content.length + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0);
      if (acc >= keepChars && m.role === "user") {
        splitIndex = i;
        break;
      }
    }
    if (splitIndex <= 1 || splitIndex >= this.messages.length) return false;
    return this.compactRange(1, splitIndex, callbacks, signal);
  }

  /** Index of the user message that starts the final round (or 1). */
  private lastUserRoundStart(): number {
    for (let i = this.messages.length - 1; i >= 1; i--) {
      if (this.messages[i]!.role === "user") return i;
    }
    return 1;
  }

  /**
   * Summarize messages[start, end) into a single user+assistant note pair and
   * splice it in. Whole rounds are compacted so tool_call/tool_result pairs stay
   * valid. On summarizer failure, falls back to the hard drop (trimContext).
   */
  private async compactRange(
    start: number,
    end: number,
    callbacks: AgentCallbacks,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const slice = this.messages.slice(start, end);
    if (slice.length === 0) return false;
    const beforeChars = this.contextSize();
    let summary: string;
    try {
      summary = await this.summarize(slice);
    } catch {
      return false;
    }
    if (signal?.aborted) return false;
    if (!summary.trim()) return false;
    const replacement: Message[] = [
      { role: "user", content: COMPACT_REQUEST },
      { role: "assistant", content: `${SUMMARY_MARKER}\n${summary.trim()}` },
    ];
    this.messages.splice(start, end - start, ...replacement);
    callbacks.onCompact?.({
      summarizedMessages: slice.length,
      beforeChars,
      afterChars: this.contextSize(),
    });
    return true;
  }

  /** Default summarizer: a single, tool-free provider call. */
  private async summarizeWithProvider(slice: Message[]): Promise<string> {
    const transcript = slice
      .map((m) => {
        if (m.role === "user") return `User: ${m.content}`;
        if (m.role === "assistant") {
          const calls = m.toolCalls?.length
            ? ` [called: ${m.toolCalls.map((c) => c.name).join(", ")}]`
            : "";
          return `Assistant: ${m.content}${calls}`;
        }
        if (m.role === "tool") {
          return `Tool(${m.name ?? "?"}): ${m.content.slice(0, 400)}`;
        }
        return `${m.role}: ${m.content}`;
      })
      .join("\n");
    const result = await this.provider.chat({
      messages: [
        {
          role: "system",
          content:
            "You compress a coding session transcript into a compact briefing that lets the assistant continue seamlessly. Preserve: the user's goals and constraints, decisions made, files created/edited and key code facts, commands run and their outcomes, and any open TODOs or unresolved errors. Omit chit-chat. Use terse bullet points.",
        },
        {
          role: "user",
          content: `Summarize this conversation so far:\n\n---\n${transcript}\n---`,
        },
      ],
      tools: [],
    });
    return result.text;
  }

  /**
   * Drop the oldest complete conversation rounds when the total size exceeds
   * the budget. A "round" starts at a user message; dropping whole rounds keeps
   * assistant tool_call / tool_result pairs valid. This is the hard fallback
   * after compaction (or when auto-compaction is disabled).
   */
  private trimContext(): void {
    while (this.contextSize() > this.maxContextChars) {
      // Preserve a leading rolling-summary pair (compaction output) so the
      // condensed history isn't discarded; drop the next oldest real round.
      let searchStart = 1;
      if (
        this.messages[1]?.content === COMPACT_REQUEST &&
        this.messages[2]?.content.startsWith(SUMMARY_MARKER)
      ) {
        searchStart = 3;
      }
      const firstUser = this.messages.findIndex(
        (m, i) => i >= searchStart && m.role === "user",
      );
      if (firstUser === -1) break;
      const nextUser = this.messages.findIndex(
        (m, i) => i > firstUser && m.role === "user",
      );
      // Keep the most recent round intact even if it exceeds the budget.
      if (nextUser === -1) break;
      this.messages.splice(firstUser, nextUser - firstUser);
    }
  }

}

/** Render the current scratchpad fields as bullet lines (no header). */
function renderScratchpadState(s: Scratchpad): string {
  const lines: string[] = [];
  if (s.goal) lines.push(`- Goal: ${s.goal}`);
  if (s.nextStep) lines.push(`- Next step: ${s.nextStep}`);
  if (s.lastError) lines.push(`- Last error: ${s.lastError}`);
  if (s.files?.length) lines.push(`- Files in play: ${s.files.join(", ")}`);
  if (s.notes?.length) {
    lines.push("- Notes:");
    for (const n of s.notes) lines.push(`  - ${n}`);
  }
  return lines.length > 0 ? lines.join("\n") : "- (empty)";
}

/** The scratchpad block appended to the system prompt (with guidance header). */
function renderScratchpadBlock(s: Scratchpad): string {
  return (
    "\n\n[Working memory / scratchpad]\n" +
    "You maintain this via the update_scratchpad tool. It is pinned here in the " +
    "system prompt, so it survives context compaction and restarts even when " +
    "older messages are dropped. During multi-step tasks, keep it current: the " +
    "goal, the next concrete step, the last unresolved error, and the files in " +
    "play. Clear the last error once resolved.\n" +
    renderScratchpadState(s)
  );
}

export { CONTROL_TOOL_NAMES };
