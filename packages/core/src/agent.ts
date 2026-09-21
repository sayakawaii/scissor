import { CONTROL_TOOL_NAMES } from "./tools/control.js";
import { coerceArray, coerceBoolean, coerceEnum, coerceStringArray } from "./tools/coerce.js";
import { suggestedToolTimeoutMs, toolTimeoutMessage } from "./tools/timeouts.js";
import { truncateMessagesFairly, truncationNotice } from "./truncate.js";
import {
  charsToTokens,
  estimateConversationTokens,
  estimateMessageTokens,
  tokenMeasure,
  type BudgetMeasure,
} from "./tokens.js";
import { defaultReminders, ReminderTracker, renderReminders, type Reminder } from "./reminders.js";
import { createSandboxPolicy, type SandboxPolicy } from "./sandbox/policy.js";
import { buildSystemPrompt, CLARIFY_GUIDANCE, section } from "./prompt.js";
import { isVagueRequest } from "./intent.js";
import {
  createApprovalGuard,
  createMinViablePathGuard,
  createOutputSpillGuard,
  createTddGuard,
} from "./guardrails.js";
import { estimateOperatingPoint, type OperatingPoint } from "./experience/estimator.js";
import type {
  ApprovalDecision,
  ApprovalPolicy,
  GuardContext,
  Guardrail,
  LLMProvider,
  Message,
  Scratchpad,
  TodoItem,
  TodoStatus,
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
  onAskUser?(question: string, options?: string[], allowMultiple?: boolean): Promise<string>;
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
  /** E3 execution-scope estimate for a run's input (observe-only, Phase 1). */
  onEstimate?(op: OperatingPoint): void;
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

/**
 * Default context budget in estimated tokens. Chosen to sit inside the smallest
 * window among the supported providers with room for the response.
 */
const DEFAULT_MAX_CONTEXT_TOKENS = 60_000;

const TODO_STATUSES: readonly TodoStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
];

/** Upper bound on how many sub-agents may run concurrently in one fan-out. */
const MAX_PARALLEL_SUBAGENTS = 5;

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
   * Soft cap on total conversation size, in estimated tokens. When exceeded, the
   * conversation is reduced to keep requests within provider limits. Preferred
   * over maxContextChars, which is converted to tokens if given instead.
   */
  maxContextTokens?: number;
  /**
   * Soft cap on total conversation size in characters. Kept for callers that
   * think in characters; internally converted to a token budget.
   */
  maxContextChars?: number;
  /** Provide a custom system prompt; otherwise a default is built. */
  systemPrompt?: string;
  /** Prior transcript (excluding system) to resume from. */
  initialMessages?: Message[];
  /** Workspace-relative globs that mutating tools must refuse to modify. */
  protectedPaths?: string[];
  /**
   * Sandbox policy for this session. Defaults to `createSandboxPolicy` for the
   * workspace, so the write-protection denylist is on unless a caller
   * deliberately replaces it.
   */
  sandbox?: SandboxPolicy;
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
   * the context budget. Set autoCompact:false to disable.
   */
  compactThreshold?: number;
  /** The same threshold expressed in estimated tokens; takes precedence. */
  compactThresholdTokens?: number;
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
  /**
   * Initial task list (e.g. restored from a resumed session). Maintained via
   * the todo_write tool and pinned into the system prompt alongside the
   * scratchpad, so an unfinished checklist survives compaction and restarts.
   */
  initialTodos?: TodoItem[];
  /** Nesting depth of this agent (0 = top-level; children are 1, ...). Internal. */
  subagentDepth?: number;
  /** Max sub-agent nesting depth allowed (default 1: children cannot spawn). */
  maxSubagentDepth?: number;
  /**
   * Guardrails run around every real tool call: they can veto a call before it
   * runs and inspect/transform its result afterward. Run in array order.
   */
  guardrails?: Guardrail[];
  /**
   * Hard ceiling on a single tool call, overriding the per-tool tier. Set this
   * to keep a run responsive at the cost of cutting off slow work; leave it
   * unset for the tiered defaults.
   */
  toolTimeoutMs?: number;
  /**
   * Situational nudges appended to the last tool result of a turn. Defaults to
   * `defaultReminders()`; pass an empty array to turn them off.
   */
  reminders?: Reminder[];
  /**
   * Auto intent-clarification. When true, each run's user input is checked by a
   * cheap heuristic; if it looks clearly vague, clarification guidance is
   * appended to the system prompt for that run only, nudging the model to lead
   * with a single clarifying question. Off for specific requests (zero cost).
   */
  autoClarify?: boolean;
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
  /** Context budget in estimated tokens; every internal budget is in tokens. */
  private maxContextTokens: number;
  /** How this agent converts text to budget units (tokens for its provider). */
  private measure: BudgetMeasure;
  private messages: Message[];
  private protectedPaths: string[];
  /** Always-on write protection and read/network boundaries for this session. */
  private sandbox: SandboxPolicy;
  private verify?: VerifyFn;
  private maxVerifyAttempts: number;
  private autoCompact: boolean;
  private compactThresholdTokens: number;
  private summarize: SummarizeFn;
  private memoryFile?: string;
  private subagentDepth: number;
  private maxSubagentDepth: number;
  /**
   * The effective guardrail chain run around every real tool call: built-in
   * TDD (when enabled) + user guardrails + the approval and spill guards, in
   * that order.
   */
  private guardrails: Guardrail[];
  /**
   * Just the caller-supplied guardrails. Kept separate from the effective chain
   * so a child agent inherits the caller's policy and builds its own built-ins,
   * instead of inheriting ours and then appending a second copy of each.
   */
  private userGuardrails: Guardrail[];
  /** Optional override of the per-tool execution ceiling. */
  private toolTimeoutMs?: number;
  /** System prompt without the dynamic scratchpad block appended. */
  private baseSystemPrompt: string;
  /** Structured working memory, pinned into the system prompt. */
  private scratchpad: Scratchpad;
  /** Structured task list, pinned into the system prompt. */
  private todos: TodoItem[];
  /** Per-run counters behind the system-reminder nudges. */
  private reminders = new ReminderTracker();
  /** The reminder rules evaluated after each turn's tool calls. */
  private reminderRules: Reminder[];
  /** Set when restart_self is invoked during a run. */
  private pendingRestart?: { reason: string };
  /** When true, apply the vagueness heuristic to each run's user input. */
  private autoClarify: boolean;
  /** True only for the duration of a run whose input was flagged vague. */
  private clarifyActive = false;
  /** E3 operating point for the run in flight (set in run() when estimation is on). */
  private currentEstimate?: OperatingPoint;

  constructor(opts: AgentOptions) {
    this.provider = opts.provider;
    this.tools = opts.tools;
    this.toolMap = new Map(opts.tools.map((t) => [t.name, t]));
    this.workspaceRoot = opts.workspaceRoot;
    this.approvalPolicy = opts.approvalPolicy ?? "plan-gate";
    this.maxTurns = opts.maxTurns ?? 25;
    // Budgets live in tokens. A caller-supplied character cap is converted with
    // this provider's ratio so the two spellings mean the same thing.
    this.measure = tokenMeasure(this.provider.id);
    this.maxContextTokens =
      opts.maxContextTokens ??
      (opts.maxContextChars !== undefined
        ? charsToTokens(opts.maxContextChars, this.provider.id)
        : DEFAULT_MAX_CONTEXT_TOKENS);
    this.protectedPaths = opts.protectedPaths ?? [];
    this.sandbox = opts.sandbox ?? createSandboxPolicy(this.workspaceRoot);
    this.verify = opts.verify;
    this.maxVerifyAttempts = opts.maxVerifyAttempts ?? 2;
    this.autoCompact = opts.autoCompact ?? true;
    this.compactThresholdTokens =
      opts.compactThresholdTokens ??
      (opts.compactThreshold !== undefined
        ? charsToTokens(opts.compactThreshold, this.provider.id)
        : Math.floor(this.maxContextTokens * 0.7));
    this.summarize = opts.summarize ?? ((msgs) => this.summarizeWithProvider(msgs));
    this.memoryFile = opts.memoryFile;
    this.subagentDepth = opts.subagentDepth ?? 0;
    this.maxSubagentDepth = opts.maxSubagentDepth ?? 1;
    this.autoClarify = opts.autoClarify ?? false;
    if (opts.toolTimeoutMs !== undefined) this.toolTimeoutMs = opts.toolTimeoutMs;
    this.reminderRules = opts.reminders ?? defaultReminders();
    // Unified lifecycle-hook chain: TDD gate (if enabled) runs first, then any
    // user-supplied guardrails (e.g. oscillation), and finally the approval
    // gate so we only prompt for calls that passed the earlier policy checks.
    this.userGuardrails = opts.guardrails ?? [];
    this.guardrails = [
      ...(opts.tddMode ? [createTddGuard()] : []),
      // E3 Phase 2: skip broad retrieval on a confident localized edit. Opt-in
      // (off by default) so normal runs and the eval gate are unchanged; reads
      // the run's operating point lazily so it always reflects the task in flight.
      ...(process.env.SCISSOR_ESTIMATE_EXECUTE === "1"
        ? [createMinViablePathGuard(() => this.currentEstimate)]
        : []),
      ...this.userGuardrails,
      createApprovalGuard(),
      // Last, so it bounds whatever the earlier hooks produced: an oversized
      // result is spilled to a file and replaced with a bounded excerpt.
      createOutputSpillGuard({ workspaceRoot: this.workspaceRoot }),
    ];
    this.baseSystemPrompt =
      opts.systemPrompt ??
      buildSystemPrompt({
        workspaceRoot: this.workspaceRoot,
        platform: process.platform,
        approvalPolicy: this.approvalPolicy,
        tools: this.tools,
      });
    this.scratchpad = opts.initialScratchpad ? { ...opts.initialScratchpad } : {};
    this.todos = opts.initialTodos ? opts.initialTodos.map((t) => ({ ...t })) : [];
    this.messages = [{ role: "system", content: this.renderSystemPrompt() }];
    if (opts.initialMessages?.length) {
      this.messages.push(...opts.initialMessages.filter((m) => m.role !== "system"));
    }
  }

  /**
   * System prompt = base prompt + the pinned scratchpad/todo blocks (if their
   * tools are enabled) + transient clarification guidance (only while a vague
   * run is in flight).
   */
  private renderSystemPrompt(): string {
    let prompt = this.baseSystemPrompt;
    if (this.toolMap.has("update_scratchpad")) {
      prompt += renderScratchpadBlock(this.scratchpad);
    }
    if (this.toolMap.has("todo_write")) {
      prompt += renderTodoBlock(this.todos);
    }
    if (this.clarifyActive) {
      prompt += `\n\n${section("clarification", CLARIFY_GUIDANCE)}`;
    }
    return prompt;
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

  /** Current task list (for persistence). */
  getTodos(): TodoItem[] {
    return this.todos;
  }

  /**
   * Apply a todo_write call. `merge` (default true) patches the given items by
   * id and appends unknown ones; false replaces the whole list. Rejects rather
   * than silently repairing two structural mistakes the model tends to make:
   * a new item with no content, and more than one item left in_progress.
   */
  private applyTodoWrite(args: Record<string, unknown>): ToolResult {
    const raw = coerceArray(args.todos, { field: "todos" });
    if (!Array.isArray(raw)) {
      return { content: "Error: 'todos' must be an array of task items.", isError: true };
    }
    const merge = coerceBoolean(args.merge) ?? true;
    const existing = new Map(this.todos.map((t) => [t.id, t]));
    const next: TodoItem[] = [];

    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) {
        return { content: "Error: each todo must be an object with id, content and status.", isError: true };
      }
      const item = entry as Record<string, unknown>;
      const id = String(item.id ?? "").trim();
      if (!id) return { content: "Error: every todo needs a non-empty 'id'.", isError: true };
      const prior = existing.get(id);
      const content = String(item.content ?? "").trim() || (prior?.content ?? "");
      if (!content) {
        return { content: `Error: todo "${id}" is new, so it needs 'content'.`, isError: true };
      }
      const status = coerceEnum(item.status, TODO_STATUSES);
      if (!status) {
        return {
          content: `Error: todo "${id}" has an invalid status. Use one of: ${TODO_STATUSES.join(", ")}.`,
          isError: true,
        };
      }
      next.push({ id, content, status });
    }

    // Merge patches by id into the existing order; replace swaps the list out.
    let merged: TodoItem[];
    if (merge) {
      const patches = new Map(next.map((t) => [t.id, t]));
      merged = this.todos.map((t) => patches.get(t.id) ?? t);
      const seen = new Set(merged.map((t) => t.id));
      for (const t of next) if (!seen.has(t.id)) merged.push(t);
    } else {
      merged = next;
    }

    const active = merged.filter((t) => t.status === "in_progress");
    if (active.length > 1) {
      return {
        content:
          `Error: ${active.length} todos are in_progress (${active.map((t) => t.id).join(", ")}). ` +
          `Keep exactly one in_progress at a time — finish or set the others back to pending.`,
        isError: true,
      };
    }

    this.todos = merged;
    this.reminders.noteTodoWrite();
    this.syncSystemPrompt();
    return { content: `Task list updated.\n${renderTodoState(this.todos)}` };
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
    this.reminders.reset();
    this.scratchpad = {};
    this.todos = [];
    this.syncSystemPrompt();
  }

  /** Run one user request to completion (may span many model turns). */
  async run(
    userInput: string,
    callbacks: AgentCallbacks = {},
    signal?: AbortSignal,
  ): Promise<RunResult> {
    this.messages.push({ role: "user", content: userInput });

    // E3 Estimate stage (Phase 1 observe / Phase 2 execute): judge the task's
    // execution scope up front. SCISSOR_ESTIMATE surfaces it (observe-only);
    // SCISSOR_ESTIMATE_EXECUTE additionally drives the min-viable-path guard,
    // which reads this.currentEstimate. Both are off by default so the default
    // behavior and the eval gate are unchanged (OPEN_ITEMS §7e).
    if (process.env.SCISSOR_ESTIMATE || process.env.SCISSOR_ESTIMATE_EXECUTE) {
      this.currentEstimate = estimateOperatingPoint({ query: userInput });
      callbacks.onEstimate?.(this.currentEstimate);
    } else {
      this.currentEstimate = undefined;
    }

    // Auto intent-clarification: only for this run, and only when the input
    // looks clearly vague. Appended to the system prompt via renderSystemPrompt.
    if (this.autoClarify && isVagueRequest(userInput)) {
      this.clarifyActive = true;
      this.syncSystemPrompt();
    }
    try {
      return await this.runLoop(callbacks, signal);
    } finally {
      if (this.clarifyActive) {
        this.clarifyActive = false;
        this.syncSystemPrompt();
      }
    }
  }

  private async runLoop(
    callbacks: AgentCallbacks = {},
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const ctx: ToolContext = {
      workspaceRoot: this.workspaceRoot,
      signal,
      protectedPaths: this.protectedPaths,
      memoryFile: this.memoryFile,
      sandbox: this.sandbox,
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
      if (this.autoCompact && !compactionFailed && this.contextSize() > this.compactThresholdTokens) {
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
          if (!report.skipped) this.reminders.noteVerified();
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

      // Execute the requested tool calls and feed results back. When a turn's
      // calls are ALL independent read-only calls (non-mutating, non-control),
      // run them concurrently. If the turn mixes in any mutating/control call,
      // run everything sequentially in original order — this keeps approval
      // prompts deterministic AND ensures a read-only call (e.g. `diagnostics`
      // or `read_file`) requested after an edit in the same turn observes the
      // post-edit state instead of racing ahead of the write. Results are always
      // pushed in original call order to keep the transcript valid.
      const calls = result.toolCalls;
      const results = new Array<ToolResult | undefined>(calls.length);

      const canParallelize =
        calls.length > 1 && calls.every((call) => this.isParallelSafe(call));
      if (canParallelize) {
        await Promise.all(
          calls.map(async (call, i) => {
            results[i] = await this.handleToolCall(call, ctx, callbacks, signal);
          }),
        );
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
      let lastToolMessage: Message | undefined;
      let lastCall: ToolCall | undefined;
      let lastFailed = false;
      for (let i = 0; i < calls.length; i++) {
        const toolResult = results[i];
        if (toolResult === undefined) continue;
        const call = calls[i]!;
        const failed = toolResult.isError === true;
        if (!failed && (call.name === "write_file" || call.name === "edit_file")) {
          editsSinceVerify = true;
          this.reminders.noteEdit();
          const p = call.arguments.path;
          if (typeof p === "string") editedFiles.add(p);
        }
        // A sub-agent may have edited files; verify after delegation too.
        if (!failed && call.name === "spawn_subagent") {
          editsSinceVerify = true;
        }
        // The agent checking its own work counts, so it isn't nagged for edits
        // it has already validated with the project's checker.
        if (!failed && call.name === "diagnostics") {
          this.reminders.noteVerified();
        }
        this.reminders.record(call.name, failed);
        const message: Message = {
          role: "tool",
          content: toolResult.content,
          toolCallId: call.id,
          name: call.name,
        };
        this.messages.push(message);
        lastToolMessage = message;
        lastCall = call;
        lastFailed = failed;
      }

      // Situational nudges ride along on the last tool result: no extra round
      // trip, and the transcript's call/result pairing stays valid.
      if (lastToolMessage && lastCall) {
        const block = renderReminders(
          this.reminderRules,
          this.reminders.context(lastCall.name, lastFailed, this.todos),
        );
        if (block) lastToolMessage.content += block;
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
      sandbox: this.sandbox,
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

  /** Build a fresh child Agent that shares this agent's provider/workspace. */
  private spawnChild(): Agent {
    // Worker tools: drop control tools (no plans/questions/restart/nested spawn).
    const controlNames = CONTROL_TOOL_NAMES as readonly string[];
    const workerTools = this.tools.filter((t) => !controlNames.includes(t.name));
    return new Agent({
      provider: this.provider,
      tools: workerTools,
      workspaceRoot: this.workspaceRoot,
      approvalPolicy: this.approvalPolicy,
      protectedPaths: this.protectedPaths,
      sandbox: this.sandbox,
      systemPrompt: this.baseSystemPrompt + SUBAGENT_PREAMBLE,
      maxTurns: this.maxTurns,
      maxContextTokens: this.maxContextTokens,
      autoCompact: this.autoCompact,
      summarize: this.summarize,
      memoryFile: this.memoryFile,
      subagentDepth: this.subagentDepth + 1,
      maxSubagentDepth: this.maxSubagentDepth,
      guardrails: this.userGuardrails,
      ...(this.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: this.toolTimeoutMs }),
    });
  }

  /** Run one delegated task in a child agent and return a structured outcome. */
  private async runOneSubagent(
    task: string,
    callbacks: AgentCallbacks,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; aborted: boolean; turns: number; summary: string }> {
    const child = this.spawnChild();
    callbacks.onSubagentStart?.(task, this.subagentDepth + 1);
    try {
      const res = await child.run(task, callbacks, signal);
      callbacks.onSubagentEnd?.(res.finalText, this.subagentDepth + 1);
      if (res.aborted) {
        return { ok: false, aborted: true, turns: res.turns, summary: "interrupted before finishing" };
      }
      return {
        ok: true,
        aborted: false,
        turns: res.turns,
        summary: res.finalText.trim() || "(the sub-agent returned no summary)",
      };
    } catch (err) {
      callbacks.onSubagentEnd?.("", this.subagentDepth + 1);
      return { ok: false, aborted: false, turns: 0, summary: `failed: ${(err as Error).message}` };
    }
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
        content: "Sub-agents cannot spawn further sub-agents. Do this sub-task yourself.",
        isError: true,
      };
    }
    const r = await this.runOneSubagent(task, callbacks, signal);
    if (r.aborted) return { content: "Sub-agent was interrupted before finishing.", isError: true };
    if (!r.ok) return { content: `Sub-agent ${r.summary}`, isError: true };
    return { content: `Sub-agent finished (${r.turns} turns). Summary:\n${r.summary}` };
  }

  /**
   * Fan out several independent sub-tasks to child agents that run CONCURRENTLY,
   * then fan in their summaries (map-reduce style). Use only for tasks that don't
   * touch the same files, since children share the workspace. The parent only
   * sees the aggregated summaries, keeping its context focused.
   */
  private async runSubagentsParallel(
    tasks: string[],
    callbacks: AgentCallbacks,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (this.subagentDepth >= this.maxSubagentDepth) {
      return {
        content: "Sub-agents cannot spawn further sub-agents. Do these sub-tasks yourself.",
        isError: true,
      };
    }
    if (tasks.length < 2) {
      return {
        content: "spawn_subagents needs at least 2 tasks; use spawn_subagent for a single task.",
        isError: true,
      };
    }
    if (tasks.length > MAX_PARALLEL_SUBAGENTS) {
      return {
        content: `Too many parallel sub-agents (${tasks.length}); the max is ${MAX_PARALLEL_SUBAGENTS}. Batch the work into fewer tasks.`,
        isError: true,
      };
    }

    const outcomes = await Promise.all(
      tasks.map((task) => this.runOneSubagent(task, callbacks, signal)),
    );

    const sections = outcomes.map((r, i) => {
      const status = r.aborted ? "INTERRUPTED" : r.ok ? `ok, ${r.turns} turns` : "FAILED";
      return `### Sub-agent ${i + 1} (${status})\nTask: ${tasks[i]}\n${r.summary}`;
    });
    const succeeded = outcomes.filter((r) => r.ok).length;
    const header = `Ran ${tasks.length} sub-agents in parallel; ${succeeded}/${tasks.length} succeeded.`;
    return {
      content: `${header}\n\n${sections.join("\n\n")}`,
      isError: succeeded === 0,
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
      const options = coerceStringArray(call.arguments.options, "options");
      const allowMultiple = coerceBoolean(call.arguments.allow_multiple) === true;
      if (!callbacks.onAskUser) {
        return { content: "No UI available to ask the user.", isError: true };
      }
      const answer = await callbacks.onAskUser(question, options, allowMultiple);
      return { content: `User answered: ${answer}` };
    }

    if (call.name === "present_plan") {
      const summary = String(call.arguments.summary ?? "");
      const steps = coerceStringArray(call.arguments.steps, "steps") ?? [];
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

    if (call.name === "todo_write") {
      return this.applyTodoWrite(call.arguments);
    }

    if (call.name === "spawn_subagent") {
      const task = String(call.arguments.task ?? "").trim();
      if (!task) return { content: "Error: 'task' is required.", isError: true };
      return this.runSubagent(task, callbacks, signal);
    }

    if (call.name === "spawn_subagents") {
      const tasks = coerceStringArray(call.arguments.tasks, "tasks") ?? [];
      if (tasks.length === 0) {
        return { content: "Error: 'tasks' must be a non-empty array of task strings.", isError: true };
      }
      return this.runSubagentsParallel(tasks, callbacks, signal);
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
    const result = await this.runWithTimeout(tool, call, ctx, signal);
    // Guardrail pipeline (after): let guards inspect/transform the result.
    let finalResult = result;
    for (const guard of this.guardrails) {
      if (!guard.afterTool) continue;
      const transformed = await guard.afterTool(call, finalResult);
      if (transformed) finalResult = transformed;
    }
    callbacks.onToolEnd?.(call, finalResult);
    return finalResult;
  }

  /**
   * Run a tool under its execution ceiling. On expiry the call is abandoned and
   * its abort signal is fired, so a cooperative tool can stop its own work
   * (e.g. `run_shell` releasing the shell it was waiting on) even though we
   * cannot cancel an arbitrary promise.
   */
  private async runWithTimeout(
    tool: Tool,
    call: ToolCall,
    ctx: ToolContext,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const limitMs = this.toolTimeoutMs ?? suggestedToolTimeoutMs(call.name, call.arguments);
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener("abort", onOuterAbort, { once: true });

    // Deliberately not unref'd: this timer is the only thing guaranteed to be
    // pending while a tool hangs, so unreffing it would let the process exit
    // instead of reporting the timeout.
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<ToolResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ content: toolTimeoutMessage(call.name, limitMs), isError: true });
      }, limitMs);
    });

    try {
      return await Promise.race([
        tool
          .run(call.arguments, { ...ctx, signal: controller.signal })
          .catch((err: unknown) => ({
            content: `Tool error: ${(err as Error).message}`,
            isError: true,
          })),
        timedOut,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  /** Approximate size of the whole conversation, in estimated tokens. */
  private contextSize(): number {
    return estimateConversationTokens(this.messages, this.provider.id);
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
    const keepTokens = Math.floor(this.maxContextTokens * 0.5);
    // Walk backwards to a round boundary once we've kept ~keepTokens recent.
    let acc = 0;
    let splitIndex = this.messages.length;
    for (let i = this.messages.length - 1; i >= 1; i--) {
      const m = this.messages[i]!;
      acc += estimateMessageTokens(m, this.provider.id);
      if (acc >= keepTokens && m.role === "user") {
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
   * Shrink the conversation to fit the budget when it is still over after (or
   * without) LLM compaction. Rather than dropping whole rounds — which throws
   * away a user request and every result around it because one old tool output
   * was large — this gives each eligible message a max-min fair share of the
   * remaining budget, so only the genuinely big messages are cut.
   *
   * Never touched: the system prompt (it pins the scratchpad and task list) and
   * the current round from the last user message onward. If those alone exceed
   * the budget there is nothing safe left to cut, so the request goes out
   * oversized rather than losing the actual task.
   */
  private trimContext(): void {
    if (this.contextSize() <= this.maxContextTokens) return;

    // Keep any leading rolling summary (compaction output) intact: it already
    // represents many rounds in very little space.
    let start = 1;
    if (
      this.messages[1]?.content === COMPACT_REQUEST &&
      this.messages[2]?.content.startsWith(SUMMARY_MARKER)
    ) {
      start = 3;
    }
    const end = this.lastUserRoundStart();
    if (end <= start) return;

    const fixedSize = this.contextSize() - this.sliceSize(start, end);
    const budget = this.maxContextTokens - fixedSize;
    if (budget <= 0) {
      // Even the protected part is over budget; abridging the middle to nothing
      // would not help, so keep it as placeholders and let the request through.
      // (Compaction is the mechanism that actually recovers from this.)
      return;
    }

    const slice = this.messages.slice(start, end);
    const { messages: reduced, omitted, shortened } = truncateMessagesFairly(
      slice,
      budget,
      this.measure,
    );
    if (omitted === 0 && shortened === 0) return;

    const notice = truncationNotice(omitted, shortened);
    if (notice && reduced[0]) {
      reduced[0] = { ...reduced[0], content: notice + reduced[0].content };
    }
    this.messages.splice(start, slice.length, ...reduced);
  }

  /** Estimated token size of messages[start, end). */
  private sliceSize(start: number, end: number): number {
    let total = 0;
    for (let i = start; i < end; i++) {
      const m = this.messages[i];
      if (m) total += estimateMessageTokens(m, this.provider.id);
    }
    return total;
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
    "\n\n" +
    section(
      "scratchpad",
      "You maintain this via the update_scratchpad tool. It is pinned here in the " +
        "system prompt, so it survives context compaction and restarts even when " +
        "older messages are dropped. During multi-step tasks, keep it current: the " +
        "goal, the next concrete step, the last unresolved error, and the files in " +
        "play. Clear the last error once resolved.\n" +
        renderScratchpadState(s),
    )
  );
}

const TODO_MARKS: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
  cancelled: "[-]",
};

/** Render the task list as checkbox lines (no header). */
function renderTodoState(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return "- (no tasks)";
  return todos.map((t) => `- ${TODO_MARKS[t.status]} ${t.id}: ${t.content}`).join("\n");
}

/** The task-list block appended to the system prompt (with guidance header). */
function renderTodoBlock(todos: readonly TodoItem[]): string {
  const remaining = todos.filter(
    (t) => t.status === "pending" || t.status === "in_progress",
  ).length;
  const nudge =
    remaining > 0
      ? `\nYou have ${remaining} unfinished task(s); do not end your turn claiming the request is done while any remain.`
      : "";
  return (
    "\n\n" +
    section(
      "task_list",
      "You maintain this via the todo_write tool. It is pinned here in the system " +
        "prompt, so it survives context compaction and restarts. Keep exactly one " +
        "task in_progress, and mark a task completed as soon as it is done." +
        nudge +
        "\n" +
        renderTodoState(todos),
    )
  );
}

export { CONTROL_TOOL_NAMES };
