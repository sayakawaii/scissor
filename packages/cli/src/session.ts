import { promises as fs } from "node:fs";
import path from "node:path";
import {
  Agent,
  adviseOptions,
  applyEnvOverrides,
  buildRepoMap,
  bucketWorkspaceSize,
  buildSystemPrompt,
  createProvider,
  createRoutedProvider,
  createExperienceRouterGuard,
  defaultTools,
  chatTools,
  createOscillationGuard,
  EXPERIENCE_SCHEMA_VERSION,
  getConfigDir,
  listWorkspaceFiles,
  renderAdviceForPrompt,
  loadConfig,
  loadMcpConfig,
  McpManager,
  MissingApiKeyError,
  newSessionId,
  normalizeErrorSignature,
  resolveModel,
  routerWouldHelp,
  saveSession,
  type ApprovalDecision,
  type ApprovalPolicy,
  type ExperienceTermination,
  type Guardrail,
  type LLMProvider,
  type PlanDecision,
  type ProviderId,
  type RouteVerdict,
  type RouterMode,
  type RoutingRule,
  type ScissorConfig,
  type SessionData,
  type Tool,
  type ToolCall,
  type ToolPreview,
} from "@scissor/core";
import { makeVerifier } from "./verify-project.js";
import { createTracer, pruneTraces, type Tracer } from "./trace.js";
import { experienceReportFromDir } from "./experience-report.js";

/** How many session traces to keep by default (override: SCISSOR_TRACE_KEEP). */
const DEFAULT_TRACE_KEEP = 50;
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
 * Build the LLM provider for a session, honoring the heuristic router. Routing
 * is now **auto** by default: it turns on when it would actually help (the
 * strong tier has a key and resolves to a distinct model), and stays off
 * otherwise, so the user needn't flip a flag. `--router`/config.router.enabled
 * force it on; `SCISSOR_NO_ROUTER=1` (or opts.router===false) force it off.
 */
function createProviderForSession(
  config: ScissorConfig,
  providerId: ProviderId,
  opts: SessionOptions,
  tracer?: Tracer,
): { provider: LLMProvider; model: string } {
  const routerDisabled = opts.router === false || process.env.SCISSOR_NO_ROUTER === "1";
  const routerForced = opts.router === true || config.router?.enabled === true;
  const routerEnabled = routerDisabled
    ? false
    : routerForced
      ? true
      : routerWouldHelp(config, providerId);

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

/**
 * Snapshot low-cardinality, secret-free workspace state features for the
 * experience layer (doc §3.1). Everything here is coarse and stable — file
 * *counts* not names, lockfile/manifest *presence* not contents — so it can
 * never leak secrets and does not blow up statistical cardinality (doc §6).
 */
export async function snapshotWorkspaceState(
  workspaceRoot: string,
  extra: { approvalPolicy: ApprovalPolicy; tdd: boolean },
): Promise<Record<string, string | number | boolean>> {
  const has = async (rel: string): Promise<boolean> => {
    try {
      await fs.stat(path.join(workspaceRoot, rel));
      return true;
    } catch {
      return false;
    }
  };

  let pkg = "none";
  if (await has("package-lock.json")) pkg = "npm";
  else if (await has("pnpm-lock.yaml")) pkg = "pnpm";
  else if (await has("yarn.lock")) pkg = "yarn";
  else if (await has("bun.lockb")) pkg = "bun";

  let lang = "unknown";
  if (await has("package.json")) lang = "node";
  else if ((await has("pyproject.toml")) || (await has("requirements.txt"))) lang = "python";
  else if (await has("go.mod")) lang = "go";
  else if (await has("Cargo.toml")) lang = "rust";
  else if ((await has("pom.xml")) || (await has("build.gradle"))) lang = "jvm";

  const vcs = (await has(".git")) ? "git" : "none";

  let size = "unknown";
  try {
    const files = await listWorkspaceFiles(workspaceRoot, { sourceOnly: true, maxFiles: 2000 });
    size = bucketWorkspaceSize(files.length);
  } catch {
    /* leave "unknown" */
  }

  return { lang, pkg, vcs, size, approval: extra.approvalPolicy, tdd: extra.tdd };
}

/**
 * Classify a tool result's termination for the experience layer (doc §7 "数据污染"):
 * a guardrail veto or a user rejection is NOT the tool's own capability failure
 * and must be recorded distinctly so it is excluded from success statistics.
 * Detection keys off the well-known result strings synthesized by the guardrail
 * pipeline (see createApprovalGuard / handleToolCall in core).
 */
function classifyTermination(
  content: string | undefined,
  isError: boolean | undefined,
): ExperienceTermination {
  const c = (content ?? "").trimStart();
  if (c.startsWith("Blocked by guardrail")) return "guardrail";
  if (c.startsWith("User rejected this action")) return "cancelled";
  return isError ? "failure" : "success";
}

/**
 * Record a normalized `tool` trace event (doc §6): success flag, duration, a
 * termination reason, an edited path, and — for genuine failures only — a
 * secret-free error signature. Shared by the interactive callbacks and the
 * eval/bench harness so both feed the experience layer identically. No-op when
 * tracing is disabled. Requires a prior `tracer.toolStart(call.id)` for `ms`.
 */
export function recordToolEvent(
  tracer: Tracer | undefined,
  call: { id: string; name: string; arguments?: Record<string, unknown> },
  result: { isError?: boolean; content?: string },
): void {
  if (!tracer) return;
  const path =
    (call.name === "write_file" || call.name === "edit_file") &&
    typeof call.arguments?.path === "string"
      ? call.arguments.path
      : undefined;
  const termination = classifyTermination(result.content, result.isError);
  const errorSignature =
    termination === "failure" ? normalizeErrorSignature(result.content) : undefined;
  tracer.record("tool", {
    name: call.name,
    ok: !result.isError,
    ms: tracer.toolMs(call.id),
    termination,
    ...(errorSignature ? { errorSignature } : {}),
    ...(path ? { path } : {}),
  });
}

/** Parse `SCISSOR_EXPERIENCE_ROUTE` into a router mode (off unless valid). */
function parseRouteMode(env: string | undefined): RouterMode {
  return env === "shadow" || env === "enforce" ? env : "off";
}

/** Parse `from>to,from>to` route rules from an env string (best-effort). */
function parseRoutingRules(env: string | undefined): RoutingRule[] {
  if (!env) return [];
  const rules: RoutingRule[] = [];
  for (const pair of env.split(",")) {
    const [from, to] = pair.split(">").map((s) => s.trim());
    if (from && to) rules.push({ from, to });
  }
  return rules;
}

/** Build an Agent from config, or throw a friendly error for the caller. */
export async function createSession(opts: SessionOptions = {}): Promise<Session> {
  const config = applyEnvOverrides(await loadConfig());
  const providerId = opts.resume?.provider ?? opts.provider ?? config.defaultProvider;
  const sessionId = opts.resume?.id ?? newSessionId();
  // Tracing is on by default (it feeds the trace -> eval flywheel and costs only
  // disk). Disable per-run with opts.trace===false or SCISSOR_NO_TRACE=1.
  const traceEnabled = !(opts.trace === false || process.env.SCISSOR_NO_TRACE === "1");
  const tracesDir = path.join(getConfigDir(), "traces");
  const tracer = traceEnabled ? createTracer(path.join(tracesDir, `${sessionId}.jsonl`)) : undefined;
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

  // Experience advisor (doc §5 Phase 3) and restricted auto-router (doc §5
  // Phase 4) are BOTH opt-in and off by default, so default agent behavior and
  // the eval gate are unchanged. Routing is additionally disabled in self-edit
  // mode. When enabled we snapshot the workspace state once (reused by tracing),
  // load the experience report once, and use it for advice and/or routing.
  const adviceEnabled = process.env.SCISSOR_EXPERIENCE_ADVICE === "1";
  const routeMode = parseRouteMode(process.env.SCISSOR_EXPERIENCE_ROUTE);
  const routeEnabled = routeMode !== "off" && !selfEdit;

  let stateSnapshot: Record<string, string | number | boolean> | undefined;
  if (traceEnabled || adviceEnabled || routeEnabled) {
    stateSnapshot = await snapshotWorkspaceState(workspaceRoot, { approvalPolicy, tdd });
  }

  let experienceAdvice: string | undefined;
  let advisedOptions: string[] = [];
  let routerGuard: Guardrail | undefined;
  if ((adviceEnabled || routeEnabled) && stateSnapshot) {
    try {
      const report = await experienceReportFromDir(tracesDir);
      if (adviceEnabled) {
        const advice = adviseOptions(report, { state: stateSnapshot });
        experienceAdvice = renderAdviceForPrompt(advice, stateSnapshot);
        advisedOptions = advice.map((a) => a.optionId);
      }
      if (routeEnabled) {
        routerGuard = createExperienceRouterGuard(
          {
            report,
            state: stateSnapshot,
            config: {
              mode: routeMode,
              rules: parseRoutingRules(process.env.SCISSOR_EXPERIENCE_ROUTE_RULES),
              killSwitch: (process.env.SCISSOR_EXPERIENCE_ROUTE_KILL ?? "")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
              version: model,
            },
          },
          {
            onDecision: (d: RouteVerdict) =>
              tracer?.record(routeMode === "enforce" ? "route-auto" : "route-shadow", {
                from: d.from,
                to: d.to,
                fromRate: d.fromRate,
                toRate: d.toRate,
                fromSamples: d.fromSamples,
                toSamples: d.toSamples,
                state: d.stateBucket,
              }),
          },
        );
      }
    } catch {
      /* advisory/routing are best-effort; never block session creation on them */
    }
  }

  const systemPrompt = buildSystemPrompt({
    workspaceRoot,
    platform: process.platform,
    approvalPolicy,
    memory,
    repoMap,
    selfEdit,
    tdd,
    clarify: clarifyMode === "always",
    experienceAdvice,
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
    guardrails: routerGuard ? [createOscillationGuard(), routerGuard] : [createOscillationGuard()],
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
    const state = stateSnapshot ?? (await snapshotWorkspaceState(workspaceRoot, { approvalPolicy, tdd }));
    tracer.record("session-start", {
      schemaVersion: EXPERIENCE_SCHEMA_VERSION,
      sessionId,
      provider: providerId,
      model,
      workspaceRoot,
      state,
    });
    // Record which options the advisor injected (if any), so a later phase can
    // correlate advice with outcomes (doc §5 Phase 3: 记录建议是否改善结果).
    if (advisedOptions.length > 0) {
      tracer.record("advice", { options: advisedOptions });
    }
    // Cap retention so default-on tracing can't grow without bound.
    const keep = Number.parseInt(process.env.SCISSOR_TRACE_KEEP ?? "", 10);
    pruneTraces(tracesDir, Number.isFinite(keep) && keep > 0 ? keep : DEFAULT_TRACE_KEEP);
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
      result: { isError?: boolean; content?: string },
    ) => {
      renderer.onToolEnd(call, result as Parameters<TurnRenderer["onToolEnd"]>[1]);
      recordToolEvent(tracer, call, result);
    },
    onRequestApproval: async (call: ToolCall, preview: ToolPreview): Promise<ApprovalDecision> => {
      const decision = await promptApproval(call, preview);
      // Decision is low-cardinality ("approve" | "reject" | "always"); no content.
      tracer?.record("approval", { name: call.name, decision });
      return decision;
    },
    onAskUser: async (
      question: string,
      options?: string[],
      allowMultiple?: boolean,
    ): Promise<string> => {
      const answer = opts.nonInteractive
        ? await autoAnswerAsk(question, options)
        : await promptAskUser(question, options, allowMultiple);
      // Privacy: record only the shape of the interaction, never the question or
      // the free-text answer (doc §6 — no user content in the experience store).
      tracer?.record("ask_user", { options: options?.length ?? 0 });
      return answer;
    },
    onPresentPlan: async (summary: string, steps: string[]): Promise<PlanDecision> => {
      const handler = opts.nonInteractive ? autoApprovePlan : promptPlan;
      const decision = await handler(summary, steps);
      tracer?.record("plan", { steps: steps.length, decision: decision.action });
      return decision;
    },
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
