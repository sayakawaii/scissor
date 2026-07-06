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

/** A large-language-model provider (deepseek, claude, gpt, glm...). */
export interface LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  chat(params: ChatParams): Promise<ChatResult>;
}
