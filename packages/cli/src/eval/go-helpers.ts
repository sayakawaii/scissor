/**
 * Cross-language bridge for the Go-based eval tasks (Schemes B/C, OPEN_ITEMS
 * §7d). scissor runs on the host (Windows in dev), but the real toolchain lives
 * in WSL, so on win32 we run `go` inside WSL against the workspace via its
 * `/mnt/<drive>` mount. Everything is offline: modules are stdlib-only and we
 * force `GOPROXY=off`, so no network is required (only the Go toolchain).
 *
 * To dodge cmd.exe/WSL nested-quoting, we write a tiny launcher script into the
 * workspace and invoke `bash <script> <args...>`; the script `cd`s to its own
 * directory and runs `go "$@"`.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { execShell } from "../self/repo.js";

/** Directory holding the `go` binary (override for non-standard installs). */
const GO_BIN_DIR = process.env.SCISSOR_GO_BIN ?? "/usr/local/go/bin";

/** Launcher written into the workspace so we never nest shell quotes. */
const GO_LAUNCHER = "__scissor_go.sh";

/**
 * Translate a Windows absolute path (`C:\a\b`) to its WSL mount
 * (`/mnt/c/a/b`). Already-POSIX paths pass through unchanged. Pure/testable.
 */
export function toWslPath(p: string): string {
  if (p.startsWith("/")) return p;
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(p);
  if (!m) return p.replace(/\\/g, "/");
  const drive = (m[1] ?? "").toLowerCase();
  const rest = (m[2] ?? "").replace(/\\/g, "/");
  return `/mnt/${drive}${rest ? "/" + rest : ""}`;
}

/** The launcher script body (bash): put go on PATH, force offline, cd, run. */
export function goLauncherScript(goBinDir: string = GO_BIN_DIR): string {
  return [
    "#!/usr/bin/env bash",
    `export PATH="$PATH:${goBinDir}"`,
    "export GOPROXY=off GOFLAGS=-mod=mod GO111MODULE=on",
    'cd "$(dirname "$0")" || exit 97',
    'go "$@"',
    "",
  ].join("\n");
}

/**
 * The shell command line that runs the launcher with `args`. On win32 it goes
 * through WSL (`wsl.exe -e bash <wsl-path> ...`); elsewhere directly. Pure so it
 * can be asserted without spawning anything.
 */
export function goCommandLine(dir: string, args: string[], platform: string = process.platform): string {
  const argLine = args.join(" ");
  if (platform === "win32") {
    return `wsl.exe -e bash ${toWslPath(path.win32.join(dir, GO_LAUNCHER))} ${argLine}`.trim();
  }
  return `bash ${path.posix.join(dir, GO_LAUNCHER)} ${argLine}`.trim();
}

/** Run `go <args>` in `dir` (via WSL on win32). Never throws. */
export async function runGo(
  dir: string,
  args: string[],
  timeoutMs = 300_000,
): Promise<{ ok: boolean; out: string }> {
  await fs.writeFile(path.join(dir, GO_LAUNCHER), goLauncherScript(), "utf8");
  const r = await execShell(goCommandLine(dir, args), dir, timeoutMs);
  return { ok: r.ok, out: (r.stdout + "\n" + r.stderr).trim() };
}

/** Whether a usable Go toolchain is reachable from `dir`. */
export async function goAvailable(dir: string): Promise<boolean> {
  const r = await runGo(dir, ["version"], 60_000);
  return r.ok && /go version/.test(r.out);
}

/**
 * The `SCISSOR_VERIFY_COMMANDS` value that wires scissor's verify loop to a Go
 * build+test (Scheme C). Runs natively where `go` is on PATH (e.g. scissor
 * running inside WSL); the two commands are `;`-separated per the verifier.
 */
export function goVerifyCommands(): string {
  return "go build ./...;go test ./...";
}
