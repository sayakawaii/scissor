import { wrapForSandbox, type BackendCommand } from "../sandbox/backend.js";
import { classifyCommand, denialMessage } from "../sandbox/command.js";
import { getShellRegistry, type AwaitOutcome, type ShellSnapshot } from "../shells.js";
import { coerceBoolean, coerceEnum, coerceNumber, coerceStringArray } from "./coerce.js";
import { displayPath } from "./paths.js";
import type { Tool, ToolContext } from "../types.js";

/** Inline output cap; the full stream always lives in the mirror file. */
const MAX_OUTPUT = 30 * 1024;

/** Escalations a command may request up front. */
export const SHELL_PERMISSIONS = ["full_network", "all"] as const;
export type ShellPermission = (typeof SHELL_PERMISSIONS)[number];

/**
 * Read the requested escalations off the tool arguments. An unrecognized value
 * is an error rather than something to ignore: silently dropping a requested
 * permission would run the command under a policy the model did not ask for.
 */
export function readPermissions(
  args: Record<string, unknown>,
): { permissions: ShellPermission[] } | { error: string } {
  const raw = args.required_permissions;
  if (raw === undefined || raw === null) return { permissions: [] };
  const names = coerceStringArray(raw, "required_permissions");
  if (!names) {
    return {
      error:
        `Error: 'required_permissions' must be an array containing ` +
        `${SHELL_PERMISSIONS.map((p) => `"${p}"`).join(" or ")}.`,
    };
  }
  const permissions: ShellPermission[] = [];
  for (const name of names) {
    const match = coerceEnum(name, SHELL_PERMISSIONS);
    if (!match) {
      return {
        error:
          `Error: unknown permission "${name}". Valid values are ` +
          `${SHELL_PERMISSIONS.map((p) => `"${p}"`).join(" and ")}.`,
      };
    }
    if (!permissions.includes(match)) permissions.push(match);
  }
  return { permissions };
}

/** How long run_shell blocks before handing back a background handle. */
export const DEFAULT_BLOCK_UNTIL_MS = 30_000;

/**
 * Whether a command should be confirmed before it runs. Delegates to the
 * canonicalizing classifier, so quoting cannot hide a destructive command from
 * the check. Categorically unsafe commands are refused outright in `run()`
 * rather than surfaced as an approval prompt.
 */
export function isDangerous(cmd: string): boolean {
  const verdict = classifyCommand(cmd);
  return verdict.kind === "deny" || verdict.kind === "confirm";
}

function clampOutput(output: string): { body: string; truncated: boolean } {
  if (output.length <= MAX_OUTPUT) return { body: output, truncated: false };
  // Keep the tail: errors and the final state of a build land at the end.
  return { body: output.slice(output.length - MAX_OUTPUT), truncated: true };
}

/** Format a finished or still-running shell as text for the model. */
function renderOutcome(
  outcome: AwaitOutcome,
  workspaceRoot: string,
  opts: { blockUntilMs: number },
): { content: string; isError: boolean } {
  const snap = outcome.snapshot;
  const file = displayPath(workspaceRoot, snap.outputFile);
  const { body, truncated } = clampOutput(snap.output);
  const output = body.trim().length > 0 ? body : "(no output yet)";
  const notes: string[] = [];
  if (snap.isolation) notes.push(`ran under ${snap.isolation}`);
  if (snap.dropped) notes.push("earlier output dropped");
  if (truncated) notes.push("output truncated to the most recent portion");
  const noteLine = notes.length > 0 ? ` (${notes.join("; ")})` : "";

  if (snap.status === "exited") {
    const code = snap.exitCode ?? "unknown";
    const header = snap.killed
      ? `Shell ${snap.id} was killed after ${snap.elapsedMs}ms.`
      : `Exit code: ${code} (shell ${snap.id}, ${snap.elapsedMs}ms)`;
    return {
      content: `${header}\nFull output: ${file}${noteLine}\n\n${output}`,
      isError: snap.exitCode !== 0,
    };
  }

  if (outcome.reason === "pattern") {
    return {
      content:
        `Shell ${snap.id} is still running (pid ${snap.pid ?? "unknown"}); ` +
        `the pattern matched: ${JSON.stringify(outcome.match ?? "")}\n` +
        `Full output: ${file}${noteLine}\n\n${output}`,
      isError: false,
    };
  }

  return {
    content:
      `Shell ${snap.id} is still running in the background after ${opts.blockUntilMs}ms ` +
      `(pid ${snap.pid ?? "unknown"}).\n` +
      `Poll it with await_shell (shell_id "${snap.id}"), optionally with a pattern to ` +
      `block until a specific line appears. Kill it by running the platform's kill ` +
      `command against pid ${snap.pid ?? "unknown"}.\n` +
      `Full output: ${file}${noteLine}\n\n${output}`,
    isError: false,
  };
}

export const runShellTool: Tool = {
  name: "run_shell",
  description:
    "Run a shell command in the workspace directory. Use for building, testing, running scripts, and git. " +
    "The command is started and this tool blocks for up to block_until_ms; if it is still running then, it keeps running in the background and you get a shell id plus an output file to poll with await_shell. " +
    "So long-running commands are fine: pass block_until_ms: 0 to background a dev server or watcher immediately, or a generous value for a slow build. " +
    "Full output is always mirrored to the file, even when the inline text is truncated.",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line to execute." },
      block_until_ms: {
        type: "number",
        description:
          `How long to wait for the command before moving it to the background (default ${DEFAULT_BLOCK_UNTIL_MS}). ` +
          `Use 0 to background it immediately — do that for dev servers, watchers, and anything you do not need the result of right now. ` +
          `Size it to the command's expected runtime plus a margin.`,
      },
      is_background: {
        type: "boolean",
        description: "Equivalent to block_until_ms: 0 — start the command and return immediately.",
      },
      required_permissions: {
        type: "array",
        items: { type: "string", enum: ["full_network", "all"] },
        description:
          "Request an escalation when you already know the command needs it, rather than letting it fail first. " +
          "'full_network' lifts the network restriction (needed for installs, fetches, and pushes when the sandbox blocks the network). " +
          "'all' runs outside the sandbox entirely and always requires the user's confirmation, so use it only when nothing narrower works.",
      },
    },
    required: ["command"],
  },
  async preview(args) {
    const cmd = String(args.command ?? "");
    const verdict = classifyCommand(cmd);
    const requested = readPermissions(args);
    const escalations = "permissions" in requested ? requested.permissions : [];
    const notes = [
      verdict.kind === "allow" ? undefined : verdict.reason,
      escalations.length > 0 ? `requests: ${escalations.join(", ")}` : undefined,
    ].filter(Boolean);
    return {
      summary: `run: ${cmd}`,
      detail: notes.length > 0 ? `${cmd}\n\n(${notes.join("; ")})` : cmd,
      // 'all' leaves the sandbox, so it always goes to the user regardless of
      // how innocuous the command line looks.
      dangerous: verdict.kind !== "allow" || escalations.includes("all"),
    };
  },
  async run(args, ctx: ToolContext) {
    const command = String(args.command ?? "").trim();
    if (!command) return { content: "Error: 'command' is required.", isError: true };

    // Fail closed: categorically unsafe (or unparseable) commands never run, no
    // matter the approval policy or whether a UI is attached.
    const verdict = classifyCommand(command);
    if (verdict.kind === "deny") {
      return { content: denialMessage(command, verdict), isError: true };
    }

    const escalation = readPermissions(args);
    if ("error" in escalation) return { content: escalation.error, isError: true };
    const permissions = escalation.permissions;

    const background = coerceBoolean(args.is_background) === true;
    const window = coerceNumber(args.block_until_ms);
    const blockUntilMs = background
      ? 0
      : window !== undefined && window >= 0
        ? window
        : DEFAULT_BLOCK_UNTIL_MS;

    // Apply hard isolation before spawning. A requested-but-unusable backend
    // throws: running on the host instead would defeat the point of asking.
    let wrapped: BackendCommand = { command, isolation: "none" };
    if (ctx.sandbox) {
      try {
        wrapped = await wrapForSandbox(command, ctx.sandbox, {
          cwd: ctx.workspaceRoot,
          networkGranted: permissions.includes("full_network"),
          bypass: permissions.includes("all"),
        });
      } catch (err) {
        return { content: `Error: ${(err as Error).message}`, isError: true };
      }
    }

    const registry = getShellRegistry(ctx.workspaceRoot);
    let snap: ShellSnapshot;
    try {
      snap = registry.start(command, {
        cwd: ctx.workspaceRoot,
        exec: wrapped.command,
        ...(wrapped.isolation === "none" ? {} : { isolation: wrapped.isolation }),
      });
    } catch (err) {
      return { content: `Failed to start command: ${(err as Error).message}`, isError: true };
    }

    const outcome = await registry.wait(snap.id, {
      blockUntilMs,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (!outcome) {
      return { content: `Shell ${snap.id} disappeared before it could be awaited.`, isError: true };
    }
    if (outcome.reason === "aborted") {
      registry.kill(snap.id);
      return { content: `Command interrupted (shell ${snap.id}).`, isError: true };
    }
    return renderOutcome(outcome, ctx.workspaceRoot, { blockUntilMs });
  },
};

export const awaitShellTool: Tool = {
  name: "await_shell",
  description:
    "Poll or wait on a shell started by run_shell. Blocks until the shell exits, until the regex in `pattern` matches its output, or until block_until_ms elapses — whichever happens first. " +
    "Use `pattern` instead of guessing at sleeps: e.g. wait for a server's 'listening on' line rather than waiting a fixed number of seconds. " +
    "Omit shell_id to simply sleep for block_until_ms (useful for giving a background process a moment before checking on it). " +
    "Prefer doing other useful work over polling repeatedly.",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      shell_id: {
        type: "string",
        description: "The shell id returned by run_shell. Omit to just sleep for block_until_ms.",
      },
      block_until_ms: {
        type: "number",
        description: "Maximum time to block, in milliseconds (default 30000). Use 0 for an immediate status check.",
      },
      pattern: {
        type: "string",
        description:
          "Optional regex (JavaScript syntax, multiline flag) matched against everything the shell has printed so far. Resolves as soon as it matches.",
      },
    },
  },
  async run(args, ctx: ToolContext) {
    const requested = coerceNumber(args.block_until_ms);
    const blockUntilMs =
      requested !== undefined && requested >= 0 ? requested : DEFAULT_BLOCK_UNTIL_MS;
    const rawId = args.shell_id;
    const id = rawId === undefined || rawId === null ? "" : String(rawId).trim();
    const pattern = typeof args.pattern === "string" && args.pattern.trim() ? args.pattern : undefined;

    // No id: behave as a plain sleep, so the model has one obvious way to wait.
    if (!id) {
      if (pattern) {
        return {
          content: "Error: 'pattern' needs a 'shell_id' — there is no output to match without one.",
          isError: true,
        };
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, blockUntilMs);
        ctx.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      return { content: `Waited ${blockUntilMs}ms.` };
    }

    const registry = getShellRegistry(ctx.workspaceRoot);
    if (!registry.snapshot(id)) {
      const known = registry.list().map((s) => s.id);
      return {
        content:
          `Unknown shell_id "${id}".` +
          (known.length > 0 ? ` Known shells: ${known.join(", ")}.` : " No shells have been started."),
        isError: true,
      };
    }

    let outcome: AwaitOutcome | undefined;
    try {
      outcome = await registry.wait(id, {
        blockUntilMs,
        ...(pattern ? { pattern } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (err) {
      return { content: `Error: ${(err as Error).message}`, isError: true };
    }
    if (!outcome) return { content: `Unknown shell_id "${id}".`, isError: true };
    if (outcome.reason === "aborted") {
      return { content: `Wait on shell ${id} interrupted.`, isError: true };
    }
    // A still-running shell is a normal, non-error outcome for a poll.
    const rendered = renderOutcome(outcome, ctx.workspaceRoot, { blockUntilMs });
    if (outcome.reason === "timeout" && pattern) {
      return {
        content:
          `Pattern ${JSON.stringify(pattern)} did not match within ${blockUntilMs}ms.\n${rendered.content}`,
        isError: false,
      };
    }
    return rendered;
  },
};