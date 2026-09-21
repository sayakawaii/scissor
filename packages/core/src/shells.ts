import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Long-running shell support.
 *
 * `run_shell` used to be strictly synchronous with a hard 120s kill, so scissor
 * could not start a dev server, drive a watcher, or sit through a slow build —
 * the agent's only options were "finish in two minutes" or "fail". Here a
 * command is instead *started* and tracked: the caller blocks for as long as it
 * likes, and if the command outlives that window it keeps running in the
 * background while the agent gets a handle plus a file it can poll.
 *
 * Output is mirrored to `.scissor/terminals/<id>.txt` with a metadata header
 * and, once the command exits, a footer carrying the exit code. The whole file
 * is rewritten on a throttled flush rather than appended to, which keeps the
 * header live (`running_for_ms`) at the cost of one small write per interval.
 */

/** Retained output per shell. Older bytes are dropped once this is exceeded. */
const MAX_BUFFER = 256 * 1024;

/** Minimum gap between file rewrites while a command is producing output. */
const FLUSH_INTERVAL_MS = 250;

export const TERMINALS_DIRNAME = path.join(".scissor", "terminals");

export type ShellStatus = "running" | "exited";

export interface ShellSnapshot {
  id: string;
  command: string;
  cwd: string;
  pid?: number;
  status: ShellStatus;
  exitCode: number | null;
  /** True when the process was killed rather than exiting on its own. */
  killed: boolean;
  elapsedMs: number;
  /** Absolute path of the mirrored output file. */
  outputFile: string;
  /** Captured output (subject to MAX_BUFFER). */
  output: string;
  /** True when earlier output was dropped to stay within MAX_BUFFER. */
  dropped: boolean;
  /** How the command was isolated, when it ran under a sandbox backend. */
  isolation?: string;
}

/** Why an await returned. */
export type AwaitReason = "exited" | "pattern" | "timeout" | "aborted";

export interface AwaitOptions {
  /** How long to block before giving up and returning "timeout". */
  blockUntilMs?: number;
  /** Resolve as soon as this regex matches the captured output. */
  pattern?: string;
  signal?: AbortSignal;
}

export interface AwaitOutcome {
  reason: AwaitReason;
  snapshot: ShellSnapshot;
  /** The text the pattern matched, when reason is "pattern". */
  match?: string;
}

export interface StartOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * What to actually spawn, when it differs from `command` — a sandbox backend
   * wraps the command in `docker run` or `wsl`. `command` stays the line the
   * agent asked for, so snapshots and mirror files remain readable.
   */
  exec?: string;
  /** Human-readable description of the isolation applied, for the header. */
  isolation?: string;
}

class Shell {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly outputFile: string;
  readonly startedAt = Date.now();
  readonly isolation?: string;

  private child: ChildProcess;
  private buffer = "";
  private dropped = false;
  private exitCode: number | null = null;
  private status: ShellStatus = "running";
  private killed = false;
  private endedAt?: number;

  private flushTimer?: NodeJS.Timeout;
  private flushPending = false;
  private writing = false;
  /** Resolved once the process exits, so awaiters can race against it. */
  private readonly exited: Promise<void>;
  /** Called after every output chunk so pattern awaiters can re-test. */
  private readonly listeners = new Set<() => void>();

  constructor(id: string, command: string, cwd: string, outputFile: string, opts: StartOptions = {}) {
    this.id = id;
    this.command = command;
    this.cwd = cwd;
    this.outputFile = outputFile;
    if (opts.isolation) this.isolation = opts.isolation;

    // shell:true so the platform shell (cmd.exe / /bin/sh) parses the command
    // line, matching runProcess and how the model expects to write commands.
    this.child = spawn(opts.exec ?? command, {
      cwd,
      env: opts.env ?? process.env,
      shell: true,
      windowsHide: true,
    });

    this.exited = new Promise<void>((resolve) => {
      const settle = (code: number | null) => {
        if (this.status === "exited") return;
        this.status = "exited";
        this.exitCode = code;
        this.endedAt = Date.now();
        this.notify();
        void this.flush(true);
        resolve();
      };
      this.child.on("error", (err) => {
        this.append(`\n[failed to start: ${err.message}]\n`);
        settle(null);
      });
      this.child.on("close", (code) => settle(code));
    });

    this.child.stdout?.on("data", (b: Buffer) => this.append(b.toString()));
    this.child.stderr?.on("data", (b: Buffer) => this.append(b.toString()));
  }

  private append(text: string): void {
    this.buffer += text;
    if (this.buffer.length > MAX_BUFFER) {
      // Keep the tail: for a server or a watcher the recent lines are what
      // matter, and the full history is not worth unbounded memory.
      this.buffer = this.buffer.slice(this.buffer.length - MAX_BUFFER);
      this.dropped = true;
    }
    this.notify();
    this.scheduleFlush();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) {
      this.flushPending = true;
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      const again = this.flushPending;
      this.flushPending = false;
      void this.flush();
      if (again) this.scheduleFlush();
    }, FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
  }

  /** Rewrite the mirror file. Best-effort: a failed write never breaks a run. */
  async flush(force = false): Promise<void> {
    if (this.writing && !force) return;
    this.writing = true;
    try {
      await fs.mkdir(path.dirname(this.outputFile), { recursive: true });
      await fs.writeFile(this.outputFile, this.renderFile(), "utf8");
    } catch {
      /* mirroring is a convenience, not a requirement */
    } finally {
      this.writing = false;
    }
  }

  private renderFile(): string {
    const header = [
      "---",
      `id: ${this.id}`,
      `pid: ${this.child.pid ?? "unknown"}`,
      `cwd: ${this.cwd}`,
      `command: ${this.command}`,
      ...(this.isolation ? [`isolation: ${this.isolation}`] : []),
      `status: ${this.status}`,
      `running_for_ms: ${this.elapsedMs()}`,
      "---",
      "",
    ].join("\n");
    const body = this.dropped
      ? `[earlier output dropped to stay within ${MAX_BUFFER} bytes]\n${this.buffer}`
      : this.buffer;
    const footer =
      this.status === "exited"
        ? [
            "",
            "---",
            `exit_code: ${this.exitCode ?? "null"}`,
            `elapsed_ms: ${this.elapsedMs()}`,
            this.killed ? "killed: true" : undefined,
            "---",
            "",
          ]
            .filter((l) => l !== undefined)
            .join("\n")
        : "";
    return header + body + footer;
  }

  private elapsedMs(): number {
    return (this.endedAt ?? Date.now()) - this.startedAt;
  }

  snapshot(): ShellSnapshot {
    return {
      id: this.id,
      command: this.command,
      cwd: this.cwd,
      ...(this.child.pid === undefined ? {} : { pid: this.child.pid }),
      status: this.status,
      exitCode: this.exitCode,
      killed: this.killed,
      elapsedMs: this.elapsedMs(),
      outputFile: this.outputFile,
      output: this.buffer,
      dropped: this.dropped,
      ...(this.isolation ? { isolation: this.isolation } : {}),
    };
  }

  isRunning(): boolean {
    return this.status === "running";
  }

  kill(): void {
    if (this.status === "exited") return;
    this.killed = true;
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
  }

  /**
   * Block until the process exits, the pattern matches, or the window elapses.
   * A pattern is tested against everything captured so far (not just new
   * output), so a match that landed before the call still resolves it.
   */
  async wait(opts: AwaitOptions = {}): Promise<AwaitOutcome> {
    const blockUntilMs = Math.max(0, opts.blockUntilMs ?? 0);
    let matcher: RegExp | undefined;
    if (opts.pattern) {
      try {
        matcher = new RegExp(opts.pattern, "m");
      } catch (err) {
        throw new Error(`Invalid pattern: ${(err as Error).message}`);
      }
    }

    const testPattern = (): string | undefined => {
      if (!matcher) return undefined;
      const m = matcher.exec(this.buffer);
      return m ? m[0] : undefined;
    };

    const immediate = testPattern();
    if (immediate !== undefined) {
      await this.flush(true);
      return { reason: "pattern", snapshot: this.snapshot(), match: immediate };
    }
    if (!this.isRunning()) {
      return { reason: "exited", snapshot: this.snapshot() };
    }
    if (blockUntilMs === 0) {
      return { reason: "timeout", snapshot: this.snapshot() };
    }

    const outcome = await new Promise<AwaitReason>((resolve) => {
      let settled = false;
      const finish = (reason: AwaitReason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.listeners.delete(onOutput);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve(reason);
      };
      const onOutput = () => {
        if (testPattern() !== undefined) finish("pattern");
      };
      const onAbort = () => finish("aborted");
      // Kept ref'd: it is what holds the process open while we wait.
      const timer = setTimeout(() => finish("timeout"), blockUntilMs);
      if (matcher) this.listeners.add(onOutput);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      void this.exited.then(() => finish("exited"));
      if (opts.signal?.aborted) onAbort();
    });

    await this.flush(true);
    const match = outcome === "pattern" ? testPattern() : undefined;
    return {
      reason: outcome,
      snapshot: this.snapshot(),
      ...(match === undefined ? {} : { match }),
    };
  }
}

/**
 * Tracks the shells started in one workspace. Held per workspace root so a
 * sub-agent (which shares the workspace) can poll a shell its parent started.
 */
export class ShellRegistry {
  private readonly shells = new Map<string, Shell>();
  private nextId = 1;

  constructor(private readonly workspaceRoot: string) {}

  start(command: string, opts: StartOptions = {}): ShellSnapshot {
    const id = String(this.nextId++);
    const cwd = opts.cwd ?? this.workspaceRoot;
    const outputFile = path.join(this.workspaceRoot, TERMINALS_DIRNAME, `${id}.txt`);
    const shell = new Shell(id, command, cwd, outputFile, { ...opts, cwd });
    this.shells.set(id, shell);
    return shell.snapshot();
  }

  get(id: string): Shell | undefined {
    return this.shells.get(id);
  }

  snapshot(id: string): ShellSnapshot | undefined {
    return this.shells.get(id)?.snapshot();
  }

  list(): ShellSnapshot[] {
    return [...this.shells.values()].map((s) => s.snapshot());
  }

  async wait(id: string, opts: AwaitOptions = {}): Promise<AwaitOutcome | undefined> {
    return this.shells.get(id)?.wait(opts);
  }

  kill(id: string): boolean {
    const shell = this.shells.get(id);
    if (!shell) return false;
    shell.kill();
    return true;
  }

  /** Kill every still-running shell. Called when scissor itself shuts down. */
  killAll(): void {
    for (const shell of this.shells.values()) shell.kill();
  }
}

const registries = new Map<string, ShellRegistry>();

/** The shell registry for a workspace, created on first use. */
export function getShellRegistry(workspaceRoot: string): ShellRegistry {
  const key = path.resolve(workspaceRoot);
  let registry = registries.get(key);
  if (!registry) {
    registry = new ShellRegistry(key);
    registries.set(key, registry);
  }
  return registry;
}

/**
 * Kill every background shell in every workspace. Registered on process exit so
 * a backgrounded dev server does not outlive the agent that started it.
 */
export function killAllShells(): void {
  for (const registry of registries.values()) registry.killAll();
}

process.once("exit", killAllShells);
