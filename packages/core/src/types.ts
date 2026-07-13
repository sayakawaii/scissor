/**
 * Shared, UI-agnostic types for the scissor engine.
 * The CLI (and any future GUI) depends only on these abstractions.
 */

export type ProviderId = "deepseek" | "claude" | "gpt" | "glm";

export type MessageRole = "system" | "user" | "assistant" | "tool";

/** A single tool invocation requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments. */
  arguments: Record<string, unknown>;
}

/** A conversation message in scissor's internal, provider-neutral format. */
export interface Message {
  role: MessageRole;
  /** Text content. May be empty when the assistant only emits tool calls. */
  content: string;
  /** Present on assistant messages that request tool execution. */
  toolCalls?: ToolCall[];
  /** Present on tool-result messages: the id of the tool call being answered. */
  toolCallId?: string;
  /** Present on tool-result messages: the tool name, for readability. */
  name?: string;
}

/**
 * Structured working memory ("scratchpad"): a small, agent-maintained snapshot
 * of the current task state. It is pinned into the system prompt so it survives
 * context compaction and restarts verbatim (unlike the raw transcript).
 */
export interface Scratchpad {
  /** The task the agent is currently working toward. */
  goal?: string;
  /** The next concrete step. */
  nextStep?: string;
  /** The most recent unresolved error, if any. */
  lastError?: string;
  /** Files currently in play (workspace-relative). */
  files?: string[];
  /** Freeform working notes. */
  notes?: string[];
}

/** JSON-schema-ish parameter definition for a tool. */
export interface ToolParametersSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

/** Result returned from executing a tool. */
export interface ToolResult {
  /** Text fed back to the model. */
  content: string;
  isError?: boolean;
}

/** Context handed to a tool at execution time. */
export interface ToolContext {
  /** Absolute path of the workspace root; file ops are constrained here. */
  workspaceRoot: string;
  signal?: AbortSignal;
  /**
   * Workspace-relative glob patterns that mutating tools must refuse to touch.
   * Used in self-edit mode to protect the safety machinery (supervisor, etc.).
   */
  protectedPaths?: string[];
  /** Workspace-relative long-term memory file used by the `remember` tool. */
  memoryFile?: string;
}

/** A tool the agent can call. */
export interface Tool {
  name: string;
  description: string;
  parameters: ToolParametersSchema;
  /** Whether this tool may mutate the system (used for approval policy). */
  mutating?: boolean;
  /**
   * Optional human-readable preview of what running the tool would do
   * (e.g. a unified diff or the command to run). Shown during approval.
   */
  preview?(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolPreview>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Verdict returned by a guardrail's beforeTool hook. */
export type GuardResult = { allow: true } | { allow: false; reason: string };

/**
 * A guardrail is a lightweight lifecycle hook around tool execution. It can veto
 * a tool call before it runs (beforeTool) and/or inspect or transform a tool's
 * result after it runs (afterTool). Guardrails compose: they run in order, and a
 * single veto blocks the call. Kept intentionally simple so cross-cutting
 * concerns (oscillation detection, redaction, custom policy) live outside the
 * core loop.
 */
export interface Guardrail {
  /** Stable identifier, surfaced in the block message and traces. */
  name: string;
  /** Authorize a tool call before it runs. Return a veto to block it. */
  beforeTool?(call: ToolCall, ctx: ToolContext): GuardResult | Promise<GuardResult>;
  /**
   * Inspect a tool result after it runs. Return a new ToolResult to replace it
   * (e.g. redaction), or nothing to leave it unchanged.
   */
  afterTool?(
    call: ToolCall,
    result: ToolResult,
  ): ToolResult | void | Promise<ToolResult | void>;
}

/** Preview info surfaced to the UI before a mutating tool runs. */
export interface ToolPreview {
  /** Short one-line summary, e.g. "edit src/index.ts" or "run: npm test". */
  summary: string;
  /** Optional detailed body (unified diff, command text, etc.). */
  detail?: string;
  /** True when the action is considered destructive (deletes, force, etc.). */
  dangerous?: boolean;
}

/** Token usage reported by a provider, when available. */
export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** Streaming/event callbacks emitted while a provider produces a response. */
export interface ProviderCallbacks {
  /** Called with incremental assistant text deltas. */
  onText?: (delta: string) => void;
  /** Called once when reasoning/thinking text streams (if supported). */
  onReasoning?: (delta: string) => void;
}

export interface ChatParams {
  messages: Message[];
  tools?: Tool[];
  signal?: AbortSignal;
  callbacks?: ProviderCallbacks;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  /** Raw finish reason from the provider, for diagnostics. */
  finishReason?: string;
}

/** Outcome of running automated project verification (lint/type-check/tests). */
export interface VerificationResult {
  ok: boolean;
  /** One-line summary, e.g. "typecheck failed" or "2 checks passed". */
  summary: string;
  /** Detailed output (trimmed) fed back to the model on failure. */
  output?: string;
  /** True when there was nothing to verify (no commands detected). */
  skipped?: boolean;
}

/** Runs project verification. Provided by the UI/host, kept out of core. */
export type VerifyFn = (info: {
  editedFiles: string[];
}) => Promise<VerificationResult>;

/** A large-language-model provider (deepseek, claude, gpt, glm...). */
export interface LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  chat(params: ChatParams): Promise<ChatResult>;
}
