import { spawn } from "node:child_process";
import type { AgentTarget } from "./runner.js";
import type { EvalTask } from "./tasks.js";

/**
 * Quote one argument for a shell command line. Bare identifiers pass through;
 * everything else is double-quoted with embedded quotes/backslashes escaped.
 * (POSIX-oriented: prompts with newlines round-trip on sh; on Windows cmd,
 * external-agent benchmarking is best run under WSL.)
 */
function quoteArg(a: string): string {
  if (a.length > 0 && /^[A-Za-z0-9_\-./=:]+$/.test(a)) return a;
  return '"' + a.replace(/(["\\])/g, "\\$1") + '"';
}

export interface CommandAgentSpec {
  label: string;
  /** Executable to run (resolved on PATH). */
  command: string;
  /** Build argv (excluding the executable) from the task prompt. */
  args: (prompt: string) => string[];
  /** Extra environment for the agent process. */
  env?: Record<string, string>;
}

/**
 * An AgentTarget that shells out to an external agent CLI once per task inside
 * the prepared workspace. The agent's stdout is treated as its final answer;
 * file-based tasks are scored by inspecting the workspace afterwards. This lets
 * the same benchmark score scissor and any headless agent (e.g. goose) on
 * identical tasks with identical checks.
 */
export function commandAgentTarget(spec: CommandAgentSpec): AgentTarget {
  return {
    label: spec.label,
    runTask(task: EvalTask, workspaceRoot: string, timeoutMs: number) {
      return new Promise((resolve) => {
        // shell:true so PATH-resolved tools (e.g. "goose") and paths with spaces
        // work across platforms; we quote every arg ourselves.
        const line = [spec.command, ...spec.args(task.prompt)].map(quoteArg).join(" ");
        const child = spawn(line, {
          cwd: workspaceRoot,
          env: { ...process.env, ...spec.env },
          windowsHide: true,
          shell: true,
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (b) => (stdout += b.toString()));
        child.stderr?.on("data", (b) => (stderr += b.toString()));
        const timer = setTimeout(() => child.kill(), timeoutMs);
        child.on("error", (err) => {
          clearTimeout(timer);
          resolve({
            finalText: stdout,
            turns: 0,
            model: spec.label,
            ok: false,
            detail: `spawn failed: ${(err as Error).message}`,
          });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({
            finalText: stdout.trim() || stderr.trim(),
            turns: 0,
            model: spec.label,
            ok: code === 0,
            detail: code === 0 ? undefined : `exit ${code}: ${stderr.slice(0, 120)}`,
          });
        });
      });
    },
  };
}

/**
 * Preset for Block/AAIF goose in headless mode. Requires `goose` on PATH and a
 * provider already configured (`goose configure`). GOOSE_MODE=auto disables
 * per-action approvals so it can run unattended.
 */
export function gooseTarget(): AgentTarget {
  return commandAgentTarget({
    label: "goose",
    command: "goose",
    args: (prompt) => ["run", "--no-session", "--quiet", "-t", prompt],
    env: { GOOSE_MODE: "auto", GOOSE_DISABLE_SESSION_NAMING: "true" },
  });
}

/**
 * Build a command agent from a template string, e.g.
 *   "goose run --no-session --quiet -t {PROMPT}"
 * The literal token {PROMPT} is replaced by the task prompt as a single argv.
 */
export function commandAgentFromTemplate(label: string, template: string): AgentTarget {
  const parts = template.trim().split(/\s+/);
  const command = parts[0];
  if (!command) throw new Error("empty agent command template");
  const rest = parts.slice(1);
  return commandAgentTarget({
    label,
    command,
    args: (prompt) => rest.map((t) => (t === "{PROMPT}" ? prompt : t)),
  });
}
