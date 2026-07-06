import { promises as fs } from "node:fs";
import path from "node:path";
import {
  Agent,
  applyEnvOverrides,
  buildSystemPrompt,
  createProvider,
  defaultTools,
  chatTools,
  loadConfig,
  MissingApiKeyError,
  newSessionId,
  resolveModel,
  saveSession,
  type ApprovalPolicy,
  type ProviderId,
  type ScissorConfig,
  type SessionData,
} from "@scissor/core";
import {
  banner,
  formatToolCallHeader,
  formatToolResult,
  theme,
} from "./ui/render.js";
import { promptApproval, promptAskUser, promptPlan } from "./ui/prompts.js";

/** Long-term memory file loaded into the system prompt when present. */
export const MEMORY_FILENAME = "SCISSOR_MEMORY.md";

/** Paths scissor must not modify while editing its own source. */
export const SELF_PROTECTED_PATHS = [
  "packages/cli/src/self/**",
  "scripts/**",
];

export interface SessionOptions {
  provider?: ProviderId;
  approvalPolicy?: ApprovalPolicy;
  chatOnly?: boolean;
  workspaceRoot?: string;
  /** Enable self-edit mode (restart_self tool + protected paths + guidance). */
  selfEdit?: boolean;
  /** Resume from a previously saved session. */
  resume?: SessionData;
}

export interface Session {
  agent: Agent;
  config: ScissorConfig;
  providerId: ProviderId;
  model: string;
  workspaceRoot: string;
  /** Metadata scaffold used to persist the session. */
  data: SessionData;
}

async function readMemory(workspaceRoot: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path.join(workspaceRoot, MEMORY_FILENAME), "utf8");
  } catch {
    return undefined;
  }
}

/** Build an Agent from config, or throw a friendly error for the caller. */
export async function createSession(opts: SessionOptions = {}): Promise<Session> {
  const config = applyEnvOverrides(await loadConfig());
  const providerId = opts.resume?.provider ?? opts.provider ?? config.defaultProvider;
  const provider = createProvider(config, providerId);
  const workspaceRoot = opts.resume?.workspaceRoot ?? opts.workspaceRoot ?? process.cwd();
  const approvalPolicy = opts.resume?.approvalPolicy ?? opts.approvalPolicy ?? "plan-gate";
  const selfEdit = opts.selfEdit ?? false;

  const memory = await readMemory(workspaceRoot);
  const systemPrompt = buildSystemPrompt({
    workspaceRoot,
    platform: process.platform,
    approvalPolicy,
    memory,
    selfEdit,
  });

  const tools = opts.chatOnly ? chatTools() : defaultTools({ selfEdit });
  const agent = new Agent({
    provider,
    tools,
    workspaceRoot,
    approvalPolicy,
    systemPrompt,
    initialMessages: opts.resume?.messages,
    protectedPaths: selfEdit ? SELF_PROTECTED_PATHS : [],
  });

  const model = resolveModel(config, providerId);
  const now = new Date().toISOString();
  const data: SessionData =
    opts.resume ?? {
      formatVersion: 1,
      id: newSessionId(),
      createdAt: now,
      updatedAt: now,
      provider: providerId,
      model,
      workspaceRoot,
      approvalPolicy,
      generation: 0,
      messages: [],
    };

  return { agent, config, providerId, model, workspaceRoot, data };
}

/** Persist the current transcript to the session file. */
export async function persistSession(session: Session): Promise<void> {
  session.data.messages = session.agent.getTranscript();
  session.data.provider = session.providerId;
  session.data.model = session.model;
  session.data.workspaceRoot = session.workspaceRoot;
  await saveSession(session.data);
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
