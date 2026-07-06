import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Exit code a supervised agent child uses to request a verified restart. */
export const RESTART_EXIT_CODE = 75;

/**
 * Locate scissor's own repository root. Both the dev entry
 * (packages/cli/src/index.ts) and the built entry (packages/cli/dist/index.js)
 * live three levels below the repo root.
 */
export function getScissorRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // here is either .../packages/cli/src(/...) or .../packages/cli/dist(/...)
  // Walk up until we find the folder that contains packages/ and package.json.
  let dir = here;
  for (let i = 0; i < 6; i++) {
    dir = path.resolve(dir, "..");
    if (path.basename(dir) === "cli") {
      return path.resolve(dir, "..", "..");
    }
  }
  // Fallback: three up from the entry directory.
  return path.resolve(here, "..", "..", "..");
}

export interface ExecResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a raw command line through the shell (caller controls quoting). */
export function execShell(
  line: string,
  cwd: string,
  timeoutMs = 300_000,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(line, { cwd, env: process.env, shell: true, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b) => (stdout += b.toString()));
    child.stderr?.on("data", (b) => (stderr += b.toString()));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: stderr + String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

/**
 * Quote a single argument for a shell command line. Only wraps when needed;
 * our args never contain embedded quotes, but we escape defensively.
 */
function quoteArg(a: string): string {
  if (a.length > 0 && /^[A-Za-z0-9_\-./=:]+$/.test(a)) return a;
  return '"' + a.replace(/(["\\])/g, "\\$1") + '"';
}

/**
 * Run a command, capturing output. Runs through a shell (so npm.cmd/git resolve
 * on Windows) with explicit argument quoting to survive spaces and parens.
 */
export function exec(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 300_000,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const line = [command, ...args].map(quoteArg).join(" ");
    const child = spawn(line, {
      cwd,
      env: process.env,
      shell: true,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b) => (stdout += b.toString()));
    child.stderr?.on("data", (b) => (stderr += b.toString()));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: stderr + String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}
