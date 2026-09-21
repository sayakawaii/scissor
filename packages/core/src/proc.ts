import { spawn } from "node:child_process";

/**
 * The single place scissor spawns a shell command. Previously the same
 * "spawn a shell, capture combined output, kill on timeout/abort" logic was
 * reimplemented in the run_shell tool, the diagnostics tool, and the self/repo
 * helpers with subtly different caps and abort handling. This unifies it while
 * letting each caller keep its own output cap / timeout via options.
 */

const DEFAULT_TIMEOUT_MS = 120_000;

export interface RunProcessOptions {
  cwd: string;
  /** Kill the process after this many ms (default 120s). */
  timeoutMs?: number;
  /** Cap the combined `output` (bytes). Omit for no cap. */
  maxOutput?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface RunProcessResult {
  /** Exit code, or null when killed (timeout/abort) or failed to start. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout+stderr interleaved in arrival order (subject to maxOutput). */
  output: string;
  /** True when `output` was truncated at `maxOutput`. */
  truncated: boolean;
  /** True when the process was killed by the timeout. */
  timedOut: boolean;
  /** False when the process could not be spawned at all. */
  started: boolean;
}

/**
 * Run `command` through the platform shell (cmd.exe on Windows, /bin/sh
 * elsewhere) and resolve with its captured output and exit code. Never rejects.
 */
export function runProcess(
  command: string,
  opts: RunProcessOptions,
): Promise<RunProcessResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = opts.maxOutput;
  const env = opts.env ?? process.env;

  return new Promise((resolve) => {
    // shell:true lets Node pick and wrap the platform shell (cmd.exe / /bin/sh),
    // which correctly handles caller-quoted argument lines (e.g. git commit -m
    // "message with spaces") the same way across platforms.
    const child = spawn(command, { cwd: opts.cwd, env, shell: true, windowsHide: true });

    let stdout = "";
    let stderr = "";
    let output = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const append = (buf: Buffer, toStderr: boolean) => {
      if (truncated) return;
      const s = buf.toString();
      if (toStderr) stderr += s;
      else stdout += s;
      output += s;
      if (maxOutput !== undefined && output.length > maxOutput) {
        output = output.slice(0, maxOutput);
        truncated = true;
      }
    };

    const finish = (r: RunProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };

    child.stdout?.on("data", (b: Buffer) => append(b, false));
    child.stderr?.on("data", (b: Buffer) => append(b, true));

    // On timeout/abort we resolve promptly rather than waiting for "close":
    // on Windows, killing the shell does not reap the grandchild immediately,
    // so its pipes can stay open and "close" would hang until it exits.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      finish({ code: null, stdout, stderr, output, truncated, timedOut, started: true });
    }, timeoutMs);

    const onAbort = () => {
      child.kill();
      finish({ code: null, stdout, stderr, output, truncated, timedOut, started: true });
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      finish({
        code: null,
        stdout,
        stderr: stderr + String(err),
        output,
        truncated,
        timedOut,
        started: false,
      });
    });

    child.on("close", (code) => {
      finish({ code, stdout, stderr, output, truncated, timedOut, started: true });
    });
  });
}
