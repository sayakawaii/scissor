import { runProcess } from "../proc.js";
import type { Tool, ToolContext } from "../types.js";

const MAX_OUTPUT = 30 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

/** Heuristics for commands that warrant an explicit danger warning. */
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-rf?\b/i,
  /\brmdir\b/i,
  /\bdel\b/i,
  /\bformat\b/i,
  /\bmkfs\b/i,
  /\bgit\s+push\b.*--force/i,
  /\b(shutdown|reboot)\b/i,
  /\b:\s*\(\)\s*\{.*\}\s*;/, // fork bomb-ish
  />\s*\/dev\/sd/i,
];

function isDangerous(cmd: string): boolean {
  return DANGEROUS_PATTERNS.some((re) => re.test(cmd));
}

export const runShellTool: Tool = {
  name: "run_shell",
  description:
    "Run a shell command in the workspace directory and return its combined stdout/stderr and exit code. Use for building, testing, running scripts, and git. Avoid long-running or interactive commands.",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line to execute." },
      timeout_ms: {
        type: "number",
        description: `Optional timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}).`,
      },
    },
    required: ["command"],
  },
  async preview(args) {
    const cmd = String(args.command ?? "");
    return {
      summary: `run: ${cmd}`,
      detail: cmd,
      dangerous: isDangerous(cmd),
    };
  },
  async run(args, ctx: ToolContext) {
    const command = String(args.command ?? "");
    if (!command) return { content: "Error: 'command' is required.", isError: true };
    const timeout =
      typeof args.timeout_ms === "number" && args.timeout_ms > 0
        ? args.timeout_ms
        : DEFAULT_TIMEOUT_MS;

    const r = await runProcess(command, {
      cwd: ctx.workspaceRoot,
      timeoutMs: timeout,
      maxOutput: MAX_OUTPUT,
      signal: ctx.signal,
    });
    if (!r.started) {
      return { content: `Failed to start command: ${r.stderr.trim()}`, isError: true };
    }
    if (r.timedOut) {
      return { content: `Command timed out after ${timeout}ms.\n${r.output}`, isError: true };
    }
    const suffix = r.truncated ? "\n... (output truncated)" : "";
    const body = r.output.trim().length > 0 ? r.output + suffix : "(no output)";
    return {
      content: `Exit code: ${r.code ?? "unknown"}\n${body}`,
      isError: r.code !== 0,
    };
  },
};
