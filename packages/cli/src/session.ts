import {
  Agent,
  applyEnvOverrides,
  createProvider,
  defaultTools,
  chatTools,
  loadConfig,
  MissingApiKeyError,
  resolveModel,
  type ApprovalPolicy,
  type ProviderId,
  type ScissorConfig,
} from "@scissor/core";
import {
  banner,
  formatToolCallHeader,
  formatToolResult,
  theme,
} from "./ui/render.js";
import { promptApproval, promptAskUser, promptPlan } from "./ui/prompts.js";

export interface SessionOptions {
  provider?: ProviderId;
  approvalPolicy?: ApprovalPolicy;
  chatOnly?: boolean;
  workspaceRoot?: string;
}

export interface Session {
  agent: Agent;
  config: ScissorConfig;
  providerId: ProviderId;
  model: string;
  workspaceRoot: string;
}

/** Build an Agent from config, or throw a friendly error for the caller. */
export async function createSession(opts: SessionOptions = {}): Promise<Session> {
  const config = applyEnvOverrides(await loadConfig());
  const providerId = opts.provider ?? config.defaultProvider;
  const provider = createProvider(config, providerId);
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  const tools = opts.chatOnly ? chatTools() : defaultTools();
  const agent = new Agent({
    provider,
    tools,
    workspaceRoot,
    approvalPolicy: opts.approvalPolicy ?? "plan-gate",
  });
  return {
    agent,
    config,
    providerId,
    model: resolveModel(config, providerId),
    workspaceRoot,
  };
}

/**
 * Stateful renderer that tracks whether we are mid-line while the assistant
 * streams text, so tool banners and prompts land on fresh lines.
 */
export class TurnRenderer {
  private atLineStart = true;
  private streamedThisTurn = false;

  onAssistantText = (delta: string): void => {
    if (!this.streamedThisTurn) {
      process.stdout.write("\n" + theme.brand("scissor ") + theme.dim("› "));
      this.streamedThisTurn = true;
    }
    process.stdout.write(theme.assistant(delta));
    this.atLineStart = delta.endsWith("\n");
  };

  onTurnStart = (): void => {
    this.streamedThisTurn = false;
  };

  private ensureNewline(): void {
    if (!this.atLineStart) {
      process.stdout.write("\n");
      this.atLineStart = true;
    }
  }

  onToolStart = (call: Parameters<typeof formatToolCallHeader>[0], preview?: Parameters<typeof formatToolCallHeader>[1]): void => {
    this.ensureNewline();
    process.stdout.write(formatToolCallHeader(call, preview) + "\n");
    this.streamedThisTurn = false;
  };

  onToolEnd = (_call: unknown, result: Parameters<typeof formatToolResult>[0]): void => {
    process.stdout.write(formatToolResult(result) + "\n");
    this.atLineStart = true;
  };

  finish(): void {
    this.ensureNewline();
  }
}

/** Wire the standard CLI callbacks around an agent run. */
export function makeCallbacks(renderer: TurnRenderer) {
  return {
    onAssistantText: renderer.onAssistantText,
    onTurnStart: renderer.onTurnStart,
    onToolStart: renderer.onToolStart,
    onToolEnd: renderer.onToolEnd,
    onRequestApproval: promptApproval,
    onAskUser: promptAskUser,
    onPresentPlan: promptPlan,
  };
}

export function friendlyError(err: unknown): string {
  if (err instanceof MissingApiKeyError) {
    return `${err.message}`;
  }
  if (err instanceof Error) {
    const anyErr = err as { status?: number };
    if (anyErr.status === 401) {
      return "Authentication failed (401): check your API key with `scissor config`.";
    }
    return err.message;
  }
  return String(err);
}

export { banner };
