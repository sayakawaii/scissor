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
  createOscillationGuard,
  getConfigDir,
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
import { createTracer, type Tracer } from "./trace.js";
import {
  banner,
  formatToolCallHeader,
  formatToolResult,
  theme,
} from "./ui/render.js";
import {
  autoAnswerAsk,
  autoApprovePlan,
  promptApproval,
  promptAskUser,
  promptPlan,
} from "./ui/prompts.js";

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
  /** Lead clearly ambiguous requests with a clarifying question before planning. */
  clarify?: boolean;
  /** Connect configured MCP servers and expose their tools (interactive use). */
  mcp?: boolean;
  /** Enable the heuristic model router (cheap/strong tiers). */
  router?: boolean;
  /** Write a structured JSONL trace of the session to ~/.scissor/traces. */
  trace?: boolean;
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
  /** Structured trace sink, if tracing is enabled; caller must close() on exit. */
  tracer?: Tracer;
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
  tracer?: Tracer,
): { provider: LLMProvider; model: string } {
  let routerEnabled = opts.router ?? config.router?.enabled ?? false;
  if (process.env.SCISSOR_NO_ROUTER === "1") routerEnabled = false;

  if (!routerEnabled) {
    return { provider: createProvider(config, providerId), model: resolveModel(config, providerId) };
  }

  const routed = createRoutedProvider(config, providerId, {
    onRoute: (d) => {
      tracer?.record("route", {
        tier: d.tier,
        tierLabel: d.tierLabel,
        model: d.model,
        score: d.score,
        reasons: d.reasons,
      });
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
  const sessionId = opts.resume?.id ?? newSessionId();
  const traceEnabled = opts.trace ?? process.env.SCISSOR_TRACE === "1";
  const tracer = traceEnabled
    ? createTracer(path.join(getConfigDir(), "traces", `${sessionId}.jsonl`))
    : undefined;
  const { provider, model } = createProviderForSession(config, providerId, opts, tracer);
  const workspaceRoot = opts.resume?.workspaceRoot ?? opts.workspaceRoot ?? process.cwd();
  const approvalPolicy = opts.resume?.approvalPolicy ?? opts.approvalPolicy ?? "plan-gate";
  const selfEdit = opts.selfEdit ?? false;
  const tdd = opts.tdd ?? config.tddMode ?? false;
  // Clarification has three modes. Default is "auto": a cheap heuristic flags
  // clearly-vague inputs per request and the agent injects the guidance only
  // then. "--clarify" (or config/env) forces it on for every request; the
  // guidance is baked into the system prompt. SCISSOR_NO_CLARIFY=1 turns it off.
  const clarifyForced =
    opts.clarify === true ||
    process.env.SCISSOR_CLARIFY === "1" ||
    config.clarifyIntent === true;
  const clarifyDisabled = opts.clarify === false || process.env.SCISSOR_NO_CLARIFY === "1";
  const clarifyMode: "off" | "auto" | "always" = clarifyDisabled
    ? "off"
    : clarifyForced
      ? "always"
      : "auto";

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
    clarify: clarifyMode === "always",
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
    initialScratchpad: opts.resume?.scratchpad,
    guardrails: [createOscillationGuard()],
    autoClarify: clarifyMode === "auto",
  });

  const now = new Date().toISOString();
  const data: SessionData =
    opts.resume ?? {
      formatVersion: 1,
      id: sessionId,
      createdAt: now,
      updatedAt: now,
      provider: providerId,
      model,
      workspaceRoot,
      approvalPolicy,
      generation: 0,
      messages: [],
    };

  if (tracer) {
    tracer.record("session-start", { sessionId, provider: providerId, model, workspaceRoot });
    process.stderr.write(theme.dim(`  trace: ${tracer.filePath}`) + "\n");
  }

  return { agent, config, providerId, model, workspaceRoot, data, mcp, tracer };
}

/** Persist the current transcript to the session file. */
export async function persistSession(session: Session): Promise<void> {
  session.data.messages = session.agent.getTranscript();
  session.data.provider = session.providerId;
  session.data.model = session.model;
  session.data.workspaceRoot = session.workspaceRoot;
  session.data.scratchpad = session.agent.getScratchpad();
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

  onSubagentStart = (task: string, depth: number): void => {
    this.ensureNewline();
    const preview = task.length > 80 ? task.slice(0, 80) + "\u2026" : task;
    process.stdout.write(
      theme.info(`\u21b3 sub-agent (depth ${depth}) started: `) + theme.dim(preview) + "\n",
    );
    this.streamedThisTurn = false;
  };

  onSubagentEnd = (_summary: string, depth: number): void => {
    this.ensureNewline();
    process.stdout.write(theme.info(`\u21b3 sub-agent (depth ${depth}) finished`) + "\n");
    this.streamedThisTurn = false;
  };

  finish(): void {
    this.ensureNewline();
  }
}

export interface CallbackOptions {
  /**
   * Don't block on interactive prompts: auto-approve plans and auto-answer
   * ask_user. Set under --auto or when there is no interactive TTY, so headless
   * / piped runs never hang waiting for input that can't arrive.
   */
  nonInteractive?: boolean;
}

/** Wire the standard CLI callbacks around an agent run, with optional tracing. */
export function makeCallbacks(renderer: TurnRenderer, tracer?: Tracer, opts: CallbackOptions = {}) {
  return {
    onAssistantText: renderer.onAssistantText,
    onTurnStart: (turn: number) => {
      renderer.onTurnStart();
      tracer?.record("turn", { turn });
    },
    onToolStart: (call: Parameters<TurnRenderer["onToolStart"]>[0], preview?: Parameters<TurnRenderer["onToolStart"]>[1]) => {
      tracer?.toolStart(call.id);
      renderer.onToolStart(call, preview);
    },
    onToolEnd: (
      call: { id: string; name: string; arguments?: Record<string, unknown> },
      result: { isError?: boolean },
    ) => {
      renderer.onToolEnd(call, result as Parameters<TurnRenderer["onToolEnd"]>[1]);
      const path =
        (call.name === "write_file" || call.name === "edit_file") &&
        typeof call.arguments?.path === "string"
          ? call.arguments.path
          : undefined;
      tracer?.record("tool", {
        name: call.name,
        ok: !result.isError,
        ms: tracer?.toolMs(call.id),
        ...(path ? { path } : {}),
      });
    },
    onRequestApproval: promptApproval,
    onAskUser: (question: string, options?: string[], allowMultiple?: boolean) =>
      opts.nonInteractive
        ? autoAnswerAsk(question, options)
        : promptAskUser(question, options, allowMultiple),
    onPresentPlan: opts.nonInteractive ? autoApprovePlan : promptPlan,
    onUsage: (u: { promptTokens?: number; completionTokens?: number; totalTokens?: number }) =>
      tracer?.record("usage", { ...u }),
    onVerifyStart: renderer.onVerifyStart,
    onVerifyResult: (r: { ok: boolean; summary: string; skipped?: boolean }) => {
      renderer.onVerifyResult(r);
      tracer?.record("verify", { ok: r.ok, summary: r.summary, skipped: r.skipped });
    },
    onCompact: (info: { summarizedMessages: number; beforeChars: number; afterChars: number }) => {
      renderer.onCompact(info);
      tracer?.record("compact", {
        summarizedMessages: info.summarizedMessages,
        saved: Math.max(0, info.beforeChars - info.afterChars),
      });
    },
    onSubagentStart: (task: string, depth: number) => {
      renderer.onSubagentStart(task, depth);
      tracer?.record("subagent", { phase: "start", depth, task: task.slice(0, 200) });
    },
    onSubagentEnd: (summary: string, depth: number) => {
      renderer.onSubagentEnd(summary, depth);
      tracer?.record("subagent", { phase: "end", depth });
    },
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
