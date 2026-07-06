import { spawn } from "node:child_process";
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

    return await new Promise((resolve) => {
      const isWin = process.platform === "win32";
      const shell = isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
      const shellArgs = isWin ? ["/d", "/s", "/c", command] : ["-c", command];

      const child = spawn(shell, shellArgs, {
        cwd: ctx.workspaceRoot,
        env: process.env,
        windowsHide: true,
      });

      let output = "";
      let truncated = false;
      const append = (buf: Buffer) => {
        if (truncated) return;
        output += buf.toString();
        if (output.length > MAX_OUTPUT) {
          output = output.slice(0, MAX_OUTPUT);
          truncated = true;
        }
      };

      child.stdout.on("data", append);
      child.stderr.on("data", append);

      const timer = setTimeout(() => {
        child.kill();
        resolve({
          content: `Command timed out after ${timeout}ms.\n${output}`,
          isError: true,
        });
      }, timeout);

      const onAbort = () => {
        child.kill();
      };
      ctx.signal?.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        resolve({ content: `Failed to start command: ${err.message}`, isError: true });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        const suffix = truncated ? "\n... (output truncated)" : "";
        const body = output.trim().length > 0 ? output + suffix : "(no output)";
        resolve({
          content: `Exit code: ${code ?? "unknown"}\n${body}`,
          isError: code !== 0,
        });
      });
    });
  },
};
