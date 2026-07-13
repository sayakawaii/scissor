import { promises as fs } from "node:fs";
import path from "node:path";
import {
  Agent,
  applyEnvOverrides,
  buildRepoMap,
  buildSystemPrompt,
  createProvider,
  createRoutedProvider,
  defaultTools,
  chatTools,
  loadConfig,
  loadMcpConfig,
  McpManager,
  MissingApiKeyError,
  newSessionId,
  resolveModel,
  saveSession,
  type ApprovalPolicy,
  type LLMProvider,
  type ProviderId,
  type ScissorConfig,
  type SessionData,
  type Tool,
} from "@scissor/core";
import { makeVerifier } from "./verify-project.js";
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
  /** Disable the automated verification closed-loop. */
  noVerify?: boolean;
  /** Enforce test-first (TDD) coding: block source edits until a test exists. */
  tdd?: boolean;
  /** Connect configured MCP servers and expose their tools (interactive use). */
  mcp?: boolean;
  /** Enable the heuristic model router (cheap/strong tiers). */
  router?: boolean;
}

export interface Session {
  agent: Agent;
  config: ScissorConfig;
  providerId: ProviderId;
  model: string;
  workspaceRoot: string;
  /** Metadata scaffold used to persist the session. */
  data: SessionData;
  /** Live MCP connections, if any; caller must dispose() on exit. */
  mcp?: McpManager;
}

/** Connect configured MCP servers, or return undefined when disabled/none. */
async function connectMcp(
  workspaceRoot: string,
  enabled: boolean,
): Promise<McpManager | undefined> {
  if (!enabled || process.env.SCISSOR_NO_MCP === "1") return undefined;
  const config = await loadMcpConfig().catch(() => ({ mcpServers: {} }));
  if (Object.keys(config.mcpServers).length === 0) return undefined;
  const mgr = await McpManager.connect({
    config,
    workspaceRoot,
    onLog: (line) => process.stderr.write(theme.dim(line) + "\n"),
  });
  return mgr;
}

/**
 * Build the LLM provider for a session, honoring the heuristic router. The
 * router is opt-in: enabled by --router (opts.router), config.router.enabled, or
 * off. SCISSOR_NO_ROUTER=1 force-disables it. Returns the provider plus a model
 * label for display/persistence.
 */
function createProviderForSession(
  config: ScissorConfig,
  providerId: ProviderId,
  opts: SessionOptions,
): { provider: LLMProvider; model: string } {
  let routerEnabled = opts.router ?? config.router?.enabled ?? false;
  if (process.env.SCISSOR_NO_ROUTER === "1") routerEnabled = false;

  if (!routerEnabled) {
    return { provider: createProvider(config, providerId), model: resolveModel(config, providerId) };
  }

  const routed = createRoutedProvider(config, providerId, {
    onRoute: (d) => {
      // Only surface escalations (strong tier); cheap turns are the quiet path.
      if (d.tier === "strong") {
        process.stderr.write(
          theme.dim(`  \u21b3 router \u2192 ${d.tierLabel} [${d.reasons.join(", ") || `score ${d.score}`}]`) + "\n",
        );
      }
    },
  });
  if (routed.degraded) {
    process.stderr.write(
      theme.warn("  router: no API key for the strong tier; using the cheap tier for all turns.") + "\n",
    );
  }
  return { provider: routed.provider, model: routed.label };
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
  const { provider, model } = createProviderForSession(config, providerId, opts);
  const workspaceRoot = opts.resume?.workspaceRoot ?? opts.workspaceRoot ?? process.cwd();
  const approvalPolicy = opts.resume?.approvalPolicy ?? opts.approvalPolicy ?? "plan-gate";
  const selfEdit = opts.selfEdit ?? false;
  const tdd = opts.tdd ?? config.tddMode ?? false;

  const memory = await readMemory(workspaceRoot);
  const repoMap = await buildRepoMap(workspaceRoot).catch(() => "");
  const systemPrompt = buildSystemPrompt({
    workspaceRoot,
    platform: process.platform,
    approvalPolicy,
    memory,
    repoMap,
    selfEdit,
    tdd,
  });

  // Verification closed-loop applies only when the agent can edit files.
  const verify = opts.chatOnly
    ? undefined
    : await makeVerifier(workspaceRoot, { enabled: !opts.noVerify, tdd });

  const baseTools = opts.chatOnly ? chatTools() : defaultTools({ selfEdit });
  const mcp = await connectMcp(workspaceRoot, opts.mcp === true);
  const tools: Tool[] = mcp ? [...baseTools, ...mcp.tools] : baseTools;
  const agent = new Agent({
    provider,
    tools,
    workspaceRoot,
    approvalPolicy,
    systemPrompt,
    initialMessages: opts.resume?.messages,
    protectedPaths: selfEdit ? SELF_PROTECTED_PATHS : [],
    verify,
    memoryFile: MEMORY_FILENAME,
    tddMode: tdd,
  });

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

  return { agent, config, providerId, model, workspaceRoot, data, mcp };
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

  onVerifyStart = (): void => {
    this.ensureNewline();
    process.stdout.write(theme.info("\u25b8 verifying changes...") + "\n");
    this.streamedThisTurn = false;
  };

  onVerifyResult = (result: { ok: boolean; summary: string; skipped?: boolean }): void => {
    const mark = result.ok ? theme.ok("\u2713 ") : theme.err("\u2717 ");
    process.stdout.write("  " + mark + theme.dim(result.summary) + "\n");
    this.atLineStart = true;
  };

  onCompact = (info: { summarizedMessages: number; beforeChars: number; afterChars: number }): void => {
    this.ensureNewline();
    const saved = Math.max(0, info.beforeChars - info.afterChars);
    process.stdout.write(
      theme.info(
        `\u2b07 compacted ${info.summarizedMessages} messages into a summary (~${saved} chars saved)`,
      ) + "\n",
    );
    this.streamedThisTurn = false;
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
    onVerifyStart: renderer.onVerifyStart,
    onVerifyResult: renderer.onVerifyResult,
    onCompact: renderer.onCompact,
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
