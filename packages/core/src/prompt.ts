import type { SandboxPolicy } from "./sandbox/policy.js";
import type { Tool } from "./types.js";

export interface PromptContext {
  workspaceRoot: string;
  platform: string;
  approvalPolicy: "plan-gate" | "confirm-each" | "auto";
  /**
   * The tools actually available this session. The tool inventory is rendered
   * from this rather than hand-maintained, so the prompt cannot drift out of
   * sync with the real tool set (including MCP tools discovered at runtime).
   */
  tools?: readonly Tool[];
  /**
   * The sandbox in force. Rendered into the prompt because an agent that does
   * not know its own boundaries retries commands that can never succeed.
   */
  sandbox?: SandboxPolicy;
  /** Long-term memory (e.g. SCISSOR_MEMORY.md) injected into the prompt. */
  memory?: string;
  /** Compact repository map injected so the agent starts with an overview. */
  repoMap?: string;
  /** When true, scissor is operating on its own source (self-edit mode). */
  selfEdit?: boolean;
  /** When true, enforce a test-first (TDD) workflow. */
  tdd?: boolean;
  /** When true, lead clearly ambiguous requests with a clarifying question. */
  clarify?: boolean;
  /**
   * Optional experience-based option guidance (doc §5 Phase 3 建议模式): offline
   * success statistics rendered as advisory hints, NOT rules. Injected only when
   * the experience advisor is explicitly enabled; the agent remains the decider.
   */
  experienceAdvice?: string;
}

/**
 * Guidance injected when scissor should lead an ambiguous request with a
 * clarifying question. Used in two ways: baked into the system prompt when
 * clarification is forced on (`--clarify`), or appended dynamically for a single
 * run when the auto-detector flags the request as vague.
 */
export const CLARIFY_GUIDANCE = [
  `INTENT CLARIFICATION:`,
  `- This request looks ambiguous or underspecified. Before present_plan or any edit, your FIRST action must be a single ask_user call offering 2-3 concrete interpretations as options (include an "other" path).`,
  `- Treat likely typos and shorthand charitably: state your best reading of the request as one of the options rather than guessing silently.`,
  `- Ask at most one round, then proceed. Never ask about trivial details you can decide yourself. If, on reflection, the request is actually clear enough, skip the question and act.`,
].join("\n");

/**
 * Wrap content in a named section. The prompt is built from tagged blocks rather
 * than one flat run of `Key: value` lines: the sections that change at runtime
 * (the task list, the scratchpad) can then be re-rendered independently, and the
 * boundary between durable instructions and injected state stays unambiguous to
 * the model when a block happens to contain prose that reads like instructions.
 */
export function section(name: string, body: string): string {
  return `<${name}>\n${body.trim()}\n</${name}>`;
}

/** First sentence of a tool description, for the inventory line. */
function summarize(description: string, maxChars = 160): string {
  const oneLine = description.replace(/\s+/g, " ").trim();
  const firstSentence = /^(.+?[.!?])(\s|$)/.exec(oneLine)?.[1] ?? oneLine;
  if (firstSentence.length <= maxChars) return firstSentence;
  return firstSentence.slice(0, maxChars - 1).trimEnd() + "…";
}

/**
 * Render the tool inventory. Deliberately terse: full parameter schemas and
 * descriptions already reach the model through the provider's tool payload, so
 * repeating them here would only burn context. This is the index, not the manual.
 */
export function renderToolInventory(tools: readonly Tool[]): string {
  if (tools.length === 0) return "No tools are available; answer from the conversation alone.";
  const lines = tools.map((t) => `- ${t.name}: ${summarize(t.description)}`);
  return [
    `These tools are available (full parameter schemas come with each request):`,
    ...lines,
  ].join("\n");
}

/**
 * Describe the sandbox to the agent.
 *
 * This section is not a courtesy: an agent that does not know it is sandboxed
 * reads a blocked network call or a refused write as a mysterious, transient
 * failure and retries it — burning turns on something that will never succeed.
 * Telling it the boundaries, and how to ask for more room *before* trying, turns
 * a retry loop into one deliberate escalation.
 */
function renderSandboxSection(policy: SandboxPolicy): string {
  const lines: string[] = [];

  if (policy.type === "insecure_none") {
    lines.push(
      `Commands run unsandboxed with your full user privileges. Be correspondingly careful.`,
    );
  } else {
    lines.push(
      `Shell commands and file writes run under a sandbox. Where it applies:`,
      policy.type === "workspace_readonly"
        ? `- This run is READ-ONLY: no file may be modified and no command may write.`
        : `- Writes are confined to the workspace. Paths outside it are readable but not writable.`,
      policy.network === "none"
        ? `- Network access is BLOCKED by default. Anything that fetches, installs, clones, or pushes will fail until you request it.`
        : `- Network access is available.`,
      `- A small set of paths is never writable regardless of approval — git hooks and config, editor config, shell startup files, SSH and cloud credentials, and scissor's own config. Do not try to route around this; there is no way through it. If a task genuinely needs one of those changes, ask the user to make it.`,
    );
    lines.push(
      ``,
      `Escalating, when you already know you need it:`,
      `- Pass required_permissions: ["full_network"] to run_shell for a command that needs the network. Request it up front rather than letting the command fail first and then retrying.`,
      `- Pass required_permissions: ["all"] to run outside the sandbox. This always asks the user, so reserve it for cases where nothing narrower works and say why in your message.`,
      `- A command refused as categorically unsafe is a dead end, not a prompt: no permission unlocks it. Find another approach or hand it to the user.`,
    );
  }

  if (policy.backend && policy.backend !== "none") {
    lines.push(
      ``,
      `Commands execute inside a ${policy.backend} container/VM with the workspace mounted at the same path. The project's own toolchain is available there; host-only tools may not be.`,
    );
  }

  return lines.join("\n");
}

/** Build the system prompt that governs scissor's agent behavior. */
export function buildSystemPrompt(ctx: PromptContext): string {
  const hasWebSearch = (ctx.tools ?? []).some((t) => t.name === "web_search");
  const planGuidance =
    ctx.approvalPolicy === "plan-gate"
      ? `For any non-trivial task that will modify files or run commands, FIRST call the present_plan tool with a concise numbered plan and wait for approval. After the user approves, carry out the plan step by step without asking for approval on each individual step (except genuinely destructive actions, which are always confirmed by the environment). For trivial, single-step requests, you may skip the plan.`
      : ctx.approvalPolicy === "confirm-each"
        ? `Each file modification or command will be confirmed by the user before it runs. You may still use present_plan for complex work to align on approach.`
        : `You may execute steps directly. Use present_plan only when the user would benefit from reviewing the approach first.`;

  const sections: string[] = [
    section(
      "identity",
      `You are scissor, a personal AI coding agent that runs in the terminal. You help the user accomplish software engineering and general tasks by reasoning and using tools.`,
    ),
    section(
      "environment",
      [
        `Operating system: ${ctx.platform}`,
        `Workspace root (all file operations are constrained here): ${ctx.workspaceRoot}`,
        `Approval policy: ${ctx.approvalPolicy}`,
      ].join("\n"),
    ),
    section("tools", renderToolInventory(ctx.tools ?? [])),
    section(
      "working_principles",
      [
        `- ${planGuidance}`,
        `- Gather context before acting: read relevant files and search the codebase rather than guessing.`,
        ...(hasWebSearch
          ? [
              `- When the answer is not in this repository — an unfamiliar library, the current behavior of a third-party API, an error message from a dependency — call web_search rather than guessing from memory. If it reports that no API key is configured, treat web search as unavailable for the rest of the session and say so instead of retrying.`,
            ]
          : []),
        `- Make the smallest correct change. Prefer edit_file over rewriting whole files.`,
        `- When a request is ambiguous or depends on a user decision, call ask_user instead of assuming.`,
        `- After making changes, verify them when practical (e.g. run tests or the program).`,
        `- Long-running commands are fine: start them with a generous block_until_ms, or background them and poll, rather than avoiding them.`,
        `- Keep the user informed with short, clear explanations. Do not narrate every trivial action.`,
        `- Never fabricate file contents or command output; use tools to obtain real results.`,
        `- Use paths relative to the workspace root.`,
        `- When you have fully addressed the request, stop calling tools and give a concise final summary of what you did.`,
      ].join("\n"),
    ),
  ];

  if (ctx.sandbox) sections.push(section("sandbox", renderSandboxSection(ctx.sandbox)));

  if (ctx.clarify) sections.push(section("clarification", CLARIFY_GUIDANCE));

  if (ctx.tdd) {
    sections.push(
      section(
        "tdd_mode",
        [
          `TDD MODE (test-first) is ENABLED:`,
          `- Before writing or editing source code, FIRST write a test that specifies the desired behavior (a *.test.* file or a file under tests/).`,
          `- Run the test to confirm it fails for the right reason (red), then implement the minimal code to make it pass (green), then refactor.`,
          `- The environment enforces this: attempts to edit a source file before any test file has been created/edited this session are rejected.`,
        ].join("\n"),
      ),
    );
  }

  if (ctx.selfEdit) {
    sections.push(
      section(
        "self_edit_mode",
        [
          `The workspace above is scissor's OWN source code and you are running under the supervisor.`,
          `- After you modify scissor's source and want the changes to take effect, call restart_self with a short reason.`,
          `- The supervisor verifies the new build (type-check + build) before switching. If it fails, your changes are rolled back automatically, so make focused, coherent changes.`,
          `- Some paths are protected and cannot be modified (the supervisor and safety machinery); respect the errors if you hit them.`,
          `- Prefer small, verifiable increments. After restarting, confirm the change took effect.`,
        ].join("\n"),
      ),
    );
  }

  if (ctx.repoMap?.trim()) {
    sections.push(
      section(
        "repo_map",
        `Overview only; it may be stale after edits — use retrieve/read_file for detail.\n\n${ctx.repoMap.trim()}`,
      ),
    );
  }

  if (ctx.memory?.trim()) {
    sections.push(
      section("memory", `Long-term project memory, persisted across sessions:\n\n${ctx.memory.trim()}`),
    );
  }

  if (ctx.experienceAdvice?.trim()) {
    sections.push(section("experience", ctx.experienceAdvice.trim()));
  }

  return sections.join("\n\n");
}
