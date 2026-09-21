import path from "node:path";
import { runProcess } from "../proc.js";
import type { SandboxPolicy } from "./policy.js";

/**
 * Hard isolation backends.
 *
 * The write denylist and the command classifier are in-process checks: they stop
 * the mistakes we thought to enumerate, on the honor system. Real isolation needs
 * the kernel, and since scissor is Windows-primary the native routes the
 * reference implementation uses (seatbelt on macOS, Landlock on Linux) do not
 * apply. A container does: Docker gives a fresh namespace with only the
 * workspace bind-mounted and the network off unless granted, and WSL is the
 * cheaper equivalent already installed on most Windows dev machines.
 *
 * Two rules govern everything here:
 *
 * 1. **Never downgrade silently.** If a backend is requested and unavailable,
 *    the command fails with an explanation. Quietly running unsandboxed would
 *    mean the one time isolation mattered is the one time it wasn't there.
 * 2. **Never touch what we don't own.** Long-lived containers carry an ownership
 *    label and a schema version; an existing container with the right name but
 *    the wrong label belongs to someone else and is left strictly alone.
 */

/** Label marking a container as ours, so we never disturb a user's own. */
export const OWNER_LABEL = "com.scissor.sandbox";

/**
 * Version of the container's expected shape (mounts, env, entrypoint). Bump it
 * when that shape changes: a container labelled with an older version is
 * recreated rather than reused, which is what stops a stale container from
 * silently running commands under last release's configuration.
 */
export const SCHEMA_VERSION = "1";

export const SCHEMA_LABEL = "com.scissor.schema";

/** Default image: Node on a slim Debian base, matching scissor's own toolchain. */
export const DEFAULT_DOCKER_IMAGE = "node:22-bookworm-slim";

/** How long to wait for a backend availability probe. */
const PROBE_TIMEOUT_MS = 10_000;

/** Resource caps so a runaway command in the sandbox cannot take the host down. */
const DOCKER_LIMITS = ["--memory", "4g", "--cpus", "2", "--pids-limit", "512"];

export interface BackendCommand {
  /** The command line to hand to the platform shell. */
  command: string;
  /** Human-readable description of the isolation actually applied. */
  isolation: string;
}

export class SandboxUnavailableError extends Error {
  constructor(
    readonly backend: string,
    readonly detail: string,
  ) {
    super(
      `Sandbox backend "${backend}" was requested but is not usable: ${detail}. ` +
        `Refusing to run the command unsandboxed — fix the backend, or start scissor ` +
        `with the sandbox backend set to "none" to accept running on the host.`,
    );
    this.name = "SandboxUnavailableError";
  }
}

/** Quote a string for POSIX `sh -c`. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Quote an argument for the Windows command line. Both `docker` and `wsl` are
 * launched through the platform shell, so arguments containing spaces (paths,
 * distro names, the inner command) need wrapping.
 */
function winQuote(value: string): string {
  return /[\s"^&|<>]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function quoteArg(value: string): string {
  return process.platform === "win32" ? winQuote(value) : shQuote(value);
}

/** Translate `C:\path\to\ws` to the `/mnt/c/path/to/ws` WSL sees. */
export function toWslPath(windowsPath: string): string {
  const resolved = path.resolve(windowsPath);
  const drive = /^([a-zA-Z]):[\\/]?/.exec(resolved);
  if (!drive) return resolved.split("\\").join("/");
  const rest = resolved.slice(drive[0].length).split("\\").join("/");
  return `/mnt/${drive[1]!.toLowerCase()}/${rest}`;
}

const availability = new Map<string, { ok: boolean; detail: string }>();

/**
 * Probe a backend once per process and cache the answer. A probe costs a process
 * spawn, and the answer does not change mid-session in any way we could react to.
 */
async function probe(key: string, command: string): Promise<{ ok: boolean; detail: string }> {
  const cached = availability.get(key);
  if (cached) return cached;
  let result: { ok: boolean; detail: string };
  try {
    const r = await runProcess(command, { cwd: process.cwd(), timeoutMs: PROBE_TIMEOUT_MS });
    result =
      r.started && r.code === 0
        ? { ok: true, detail: r.output.trim().split("\n")[0] ?? "" }
        : {
            ok: false,
            detail: r.timedOut
              ? "the probe timed out"
              : (r.output.trim().split("\n")[0] ?? `exit code ${r.code}`),
          };
  } catch (err) {
    result = { ok: false, detail: (err as Error).message };
  }
  availability.set(key, result);
  return result;
}

/** Whether Docker is installed and its daemon is responding. */
export function probeDocker(): Promise<{ ok: boolean; detail: string }> {
  return probe("docker", `docker version --format "{{.Server.Version}}"`);
}

/** Whether WSL is installed and the given distribution exists. */
export function probeWsl(distro?: string): Promise<{ ok: boolean; detail: string }> {
  const target = distro ?? "";
  return probe(
    `wsl:${target}`,
    target ? `wsl -d ${quoteArg(target)} -- true` : "wsl -- true",
  );
}

/** Discard cached probe results (for tests, or after the user installs Docker). */
export function resetBackendProbes(): void {
  availability.clear();
}

/**
 * Wrap a command so it runs under the policy's backend.
 *
 * Docker runs each command in a throwaway container (`--rm`) that bind-mounts
 * the workspace at the *same absolute path* the host uses, so paths in the
 * command, in tool arguments, and in compiler output all keep meaning on both
 * sides. `--network none` unless the network was granted, plus resource caps and
 * a dropped-capability set.
 *
 * WSL reuses the identical policy through `wsl -d <distro> --cd <path>`, which is
 * meaningfully cheaper on Windows since the distribution is already running.
 *
 * Throws `SandboxUnavailableError` rather than falling back.
 */
export async function wrapForSandbox(
  command: string,
  policy: SandboxPolicy,
  opts: { cwd: string; networkGranted?: boolean; bypass?: boolean } = { cwd: process.cwd() },
): Promise<BackendCommand> {
  // An explicit, user-approved 'all' escalation runs on the host by design.
  if (opts.bypass || policy.backend === "none") {
    return { command, isolation: opts.bypass ? "none (escalated)" : "none" };
  }

  const networkAllowed = opts.networkGranted === true || policy.network === "full";

  if (policy.backend === "docker") {
    const status = await probeDocker();
    if (!status.ok) throw new SandboxUnavailableError("docker", status.detail);
    const image = policy.dockerImage ?? DEFAULT_DOCKER_IMAGE;
    const mount = path.resolve(opts.cwd);
    // Inside the container the workspace keeps its host path on POSIX; on Windows
    // there is no equivalent, so it is mounted at a fixed, predictable location.
    const inner = process.platform === "win32" ? "/workspace" : mount;
    const args = [
      "docker",
      "run",
      "--rm",
      "-i",
      "--label",
      `${OWNER_LABEL}=1`,
      "--label",
      `${SCHEMA_LABEL}=${SCHEMA_VERSION}`,
      ...(networkAllowed ? [] : ["--network", "none"]),
      ...DOCKER_LIMITS,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "-v",
      `${mount}:${inner}`,
      "-w",
      inner,
      image,
      "/bin/sh",
      "-lc",
      command,
    ];
    return {
      command: args.map(quoteArg).join(" "),
      isolation:
        `docker (${image}), workspace mounted at ${inner}, ` +
        `network ${networkAllowed ? "on" : "off"}`,
    };
  }

  if (policy.backend === "wsl") {
    const status = await probeWsl(policy.wslDistro);
    if (!status.ok) throw new SandboxUnavailableError("wsl", status.detail);
    const cwd = toWslPath(opts.cwd);
    // WSL has no per-command network namespace, so a no-network policy cannot be
    // honored here. Say so instead of pretending the command was isolated.
    const args = [
      "wsl",
      ...(policy.wslDistro ? ["-d", policy.wslDistro] : []),
      "--cd",
      cwd,
      "--",
      "/bin/sh",
      "-lc",
      command,
    ];
    return {
      command: args.map(quoteArg).join(" "),
      isolation:
        `wsl${policy.wslDistro ? ` (${policy.wslDistro})` : ""} at ${cwd}` +
        (networkAllowed ? "" : "; note: WSL shares the host network, so the no-network policy is NOT enforced"),
    };
  }

  throw new SandboxUnavailableError(String(policy.backend), "unknown backend");
}

/**
 * Remove containers we created and left behind. Only ever touches containers
 * carrying our ownership label; a same-named container without it belongs to the
 * user and is left alone.
 */
export async function cleanupOwnedContainers(): Promise<{ removed: number; detail: string }> {
  const status = await probeDocker();
  if (!status.ok) return { removed: 0, detail: `docker unavailable: ${status.detail}` };
  const list = await runProcess(`docker ps -aq --filter label=${OWNER_LABEL}=1`, {
    cwd: process.cwd(),
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  const ids = list.output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (ids.length === 0) return { removed: 0, detail: "nothing to clean up" };
  const rm = await runProcess(`docker rm -f ${ids.join(" ")}`, {
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });
  return {
    removed: rm.code === 0 ? ids.length : 0,
    detail: rm.code === 0 ? `removed ${ids.length} container(s)` : rm.output.trim(),
  };
}
