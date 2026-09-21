import os from "node:os";
import path from "node:path";
import { getConfigDir } from "../config.js";

/**
 * Sandbox policy: what a run is allowed to read, write, and reach.
 *
 * scissor already refused paths outside the workspace, but that left two real
 * holes. First, protection was opt-in — `SELF_PROTECTED_PATHS` was only
 * populated in self-edit mode — so in an ordinary session nothing stopped the
 * agent from rewriting `.git/hooks/pre-commit` or `.vscode/tasks.json`, both of
 * which turn a file edit into arbitrary code execution on the user's machine.
 * Second, none of it applied to `run_shell` at all, so any protection the file
 * tools offered was one `echo > file` away from irrelevant.
 *
 * The denylist here is therefore *always* enforced, for every run and every
 * tool, independent of approval policy. It is small on purpose: each entry is a
 * path where a write is an execution or credential-exfiltration primitive rather
 * than an ordinary edit, so blocking it costs the agent nothing it should have
 * been doing.
 */

export type SandboxPolicyType =
  /** Read the system, write only inside the workspace. The default. */
  | "workspace_readwrite"
  /** Read the system, write nothing. */
  | "workspace_readonly"
  /** No restrictions. Only for a user who has explicitly opted out. */
  | "insecure_none";

export type NetworkPolicy = "none" | "full";

/**
 * How isolation is enforced. `none` means the policy is advisory: the write
 * denylist is still checked in-process, but a command runs on the host with the
 * user's privileges. `docker` and `wsl` give real kernel-level isolation.
 */
export type SandboxBackend = "none" | "docker" | "wsl";

export interface SandboxPolicy {
  type: SandboxPolicyType;
  /** Absolute paths readable in addition to the workspace. */
  additionalReadPaths: string[];
  /** Absolute paths that are readable but never writable. */
  additionalReadonlyPaths: string[];
  /**
   * Glob patterns that must never be written, resolved against the workspace
   * root and the user's home directory. Enforced for every tool.
   */
  writeProtectionGlobs: string[];
  network: NetworkPolicy;
  /** How commands are isolated. Defaults to "none" (in-process checks only). */
  backend: SandboxBackend;
  /** Docker image to run commands in, when the backend is "docker". */
  dockerImage?: string;
  /** WSL distribution to run commands in, when the backend is "wsl". */
  wslDistro?: string;
}

/**
 * Workspace-relative paths where a write is an execution primitive: the next
 * `git commit`, editor launch, or agent run would execute the content.
 */
const WORKSPACE_WRITE_PROTECTION = [
  // Git runs these on ordinary local operations.
  ".git/hooks/**",
  ".git/config",
  ".git/info/exclude",
  // Editors and task runners execute these on open.
  ".vscode/**",
  ".idea/**",
  "*.code-workspace",
  "**/*.code-workspace",
  // Files that govern what the agent itself is allowed to see or do.
  ".cursorignore",
  ".scissorignore",
];

/** Home-relative paths holding credentials or shell startup code. */
const HOME_WRITE_PROTECTION = [
  ".ssh/**",
  ".gnupg/**",
  ".aws/credentials",
  ".docker/config.json",
  ".npmrc",
  ".git-credentials",
  ".gitconfig",
  // Shell startup files: a write here executes on the user's next terminal.
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
];

/**
 * scissor's own state. The config holds API keys and `mcp.json` declares
 * commands scissor will launch, so both are execution/credential surfaces.
 */
const CONFIG_WRITE_PROTECTION = ["config.json", "mcp.json"];

/**
 * Paths outside the workspace that a build or test almost always needs to read:
 * the toolchain, CA certificates, and the package caches. Read access is not the
 * risk we are managing, so this list is permissive by design — it exists so a
 * read-restricted backend does not break `npm test`.
 */
function defaultReadPaths(): string[] {
  const home = os.homedir();
  const candidates =
    process.platform === "win32"
      ? [
          process.env.ProgramFiles,
          process.env["ProgramFiles(x86)"],
          process.env.APPDATA,
          process.env.LOCALAPPDATA,
          process.env.SystemRoot,
          path.join(home, ".npm"),
          path.join(home, ".cache"),
        ]
      : [
          "/bin",
          "/sbin",
          "/usr",
          "/lib",
          "/lib64",
          "/etc/ssl/certs",
          "/etc/resolv.conf",
          "/opt",
          "/private/etc/ssl/certs",
          path.join(home, ".npm"),
          path.join(home, ".cache"),
          path.join(home, ".nvm"),
          path.join(home, ".cargo"),
          path.join(home, "go/pkg/mod"),
        ];
  return candidates.filter((p): p is string => typeof p === "string" && p.length > 0);
}

export interface CreatePolicyOptions {
  type?: SandboxPolicyType;
  network?: NetworkPolicy;
  /** Extra absolute read paths (e.g. a toolchain outside the defaults). */
  additionalReadPaths?: string[];
  /** Extra workspace-relative globs the caller wants protected. */
  additionalWriteProtection?: string[];
  backend?: SandboxBackend;
  dockerImage?: string;
  wslDistro?: string;
}

/**
 * Build the effective policy for a workspace. The hardcoded write protection is
 * always included: `additionalWriteProtection` can only add to it.
 */
export function createSandboxPolicy(
  workspaceRoot: string,
  opts: CreatePolicyOptions = {},
): SandboxPolicy {
  const home = os.homedir();
  const configDir = getConfigDir();
  const globs = [
    ...WORKSPACE_WRITE_PROTECTION.map((g) => path.posix.join(toPosix(workspaceRoot), g)),
    ...HOME_WRITE_PROTECTION.map((g) => path.posix.join(toPosix(home), g)),
    ...CONFIG_WRITE_PROTECTION.map((g) => path.posix.join(toPosix(configDir), g)),
    ...(opts.additionalWriteProtection ?? []).map((g) =>
      path.isAbsolute(g) ? toPosix(g) : path.posix.join(toPosix(workspaceRoot), g),
    ),
  ];

  return {
    type: opts.type ?? "workspace_readwrite",
    additionalReadPaths: [...defaultReadPaths(), ...(opts.additionalReadPaths ?? [])],
    additionalReadonlyPaths: [],
    writeProtectionGlobs: globs,
    network: opts.network ?? "full",
    backend: opts.backend ?? "none",
    ...(opts.dockerImage ? { dockerImage: opts.dockerImage } : {}),
    ...(opts.wslDistro ? { wslDistro: opts.wslDistro } : {}),
  };
}

/** Normalize a path for glob matching: forward slashes, no trailing slash. */
export function toPosix(p: string): string {
  const normalized = path.resolve(p).split(path.sep).join("/");
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
}

/**
 * Glob matcher for policy paths. Supports `*` (within one segment), `**`
 * (crossing segments), and `?`. Matching is case-insensitive because the two
 * platforms scissor targets most (Windows, macOS) have case-insensitive
 * filesystems by default, and a denylist that `.SSH` slips past is no denylist.
 */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        // `**/` should also match zero directories, so the slash is optional.
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, "i");
}

const globCache = new Map<string, RegExp>();

function matchesGlob(glob: string, target: string): boolean {
  let re = globCache.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    globCache.set(glob, re);
  }
  return re.test(target);
}

export interface WriteVerdict {
  allowed: boolean;
  /** The rule that blocked the write, when it was blocked. */
  rule?: string;
  reason?: string;
}

/**
 * Whether the policy permits writing `target` (an absolute path).
 *
 * Checks the denylist against the resolved path, so `.git/../.git/hooks/x` and a
 * symlink-free relative walk both land on the same verdict.
 */
export function checkWrite(policy: SandboxPolicy, target: string): WriteVerdict {
  if (policy.type === "insecure_none") return { allowed: true };
  const resolved = toPosix(target);

  if (policy.type === "workspace_readonly") {
    return {
      allowed: false,
      reason: "this run is read-only; no files may be modified.",
    };
  }

  for (const glob of policy.writeProtectionGlobs) {
    if (matchesGlob(glob, resolved)) {
      return {
        allowed: false,
        rule: glob,
        reason:
          `writing this path is never permitted: a write here executes code or exposes ` +
          `credentials on the next git, editor, or shell action, so it is blocked ` +
          `regardless of approval settings. Achieve the goal another way, or ask the ` +
          `user to make this change themselves.`,
      };
    }
  }

  for (const readonlyPath of policy.additionalReadonlyPaths) {
    const base = toPosix(readonlyPath);
    if (resolved === base || resolved.startsWith(base + "/")) {
      return { allowed: false, rule: base, reason: "this path is mounted read-only." };
    }
  }

  return { allowed: true };
}

/** All write-protection globs, for surfacing the policy to the user. */
export function describeWriteProtection(policy: SandboxPolicy): string[] {
  return [...policy.writeProtectionGlobs];
}
