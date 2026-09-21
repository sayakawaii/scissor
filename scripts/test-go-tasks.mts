/**
 * Deterministic test for Schemes B/C (OPEN_ITEMS §7d): the Go bridge helpers and
 * the Go bug-fix task's scaffolding. Pure/offline — it does NOT invoke `go`
 * (that needs a toolchain; validated separately). Covers path translation,
 * command construction, the launcher body, the injected bug, and that GO_TASKS
 * are reachable by id but excluded from the default suite.
 *
 * Run: node --import tsx scripts/test-go-tasks.mts
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  goCommandLine,
  goLauncherScript,
  goVerifyCommands,
  toWslPath,
} from "../packages/cli/src/eval/go-helpers.js";
import { GO_TASKS } from "../packages/cli/src/eval/go-tasks.js";
import { resolveTasks } from "../packages/cli/src/eval/bench-tasks.js";

// --- toWslPath: Windows drive paths -> /mnt/<drive>, POSIX passes through ---
assert.equal(toWslPath("C:\\Users\\me\\tmp\\x"), "/mnt/c/Users/me/tmp/x");
assert.equal(toWslPath("D:/a/b"), "/mnt/d/a/b");
assert.equal(toWslPath("/home/me/x"), "/home/me/x", "POSIX unchanged");
assert.equal(toWslPath("C:\\"), "/mnt/c", "drive root");

// --- goCommandLine: WSL bridge on win32, direct elsewhere ---
const winLine = goCommandLine("C:\\t\\ws", ["test", "./..."], "win32");
assert.match(winLine, /^wsl\.exe -e bash \/mnt\/c\/t\/ws\/__scissor_go\.sh test \.\/\.\.\.$/, winLine);
const nixLine = goCommandLine("/t/ws", ["version"], "linux");
assert.match(nixLine, /^bash \/t\/ws\/__scissor_go\.sh version$/, nixLine);

// --- launcher: offline (GOPROXY=off), puts go on PATH, cd's, runs go "$@" ---
const script = goLauncherScript("/usr/local/go/bin");
assert.match(script, /GOPROXY=off/);
assert.match(script, /export PATH="\$PATH:\/usr\/local\/go\/bin"/);
assert.match(script, /go "\$@"/);

// --- verify commands for Scheme C: build then test, ;-separated ---
assert.equal(goVerifyCommands(), "go build ./...;go test ./...");

// --- the task exists and its setup writes a real, buggy module ---
const t = GO_TASKS.find((x) => x.id === "go-uint40-decode-bug");
assert.ok(t, "go-uint40-decode-bug task exists");
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-gotask-"));
await t!.setup!(dir);

const gomod = await fs.readFile(path.join(dir, "go.mod"), "utf8");
assert.match(gomod, /^module tlvdecode$/m, "module declared");
assert.match(gomod, /^go 1\.21$/m, "low go directive so any recent toolchain builds it");

const util = await fs.readFile(path.join(dir, "internal/tlvschema/util.go"), "utf8");
assert.match(util, /uint64\(b\[0\]\)<<24/, "the injected bug (MSB shifted by 24) is present");
assert.ok(!/uint64\(b\[0\]\)<<32/.test(util), "and the correct <<32 is NOT present yet");
assert.match(util, /func BytesUInteger/, "exported entry point present");

// on-disk test exists (red→green) and a correct look-alike decoder is a red herring
assert.ok(
  await fs.stat(path.join(dir, "internal/tlvschema/util_test.go")).then(() => true).catch(() => false),
  "on-disk test present",
);
const herring = await fs.readFile(path.join(dir, "internal/bigendian/bigendian.go"), "utf8");
assert.match(herring, /func Uint32/, "red-herring correct decoder present");

await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

// --- distilled real-bug task: setup writes the pre-fix (unclamped) slice ---
const dt = GO_TASKS.find((x) => x.id === "tlv-attr-slice-panic");
assert.ok(dt, "tlv-attr-slice-panic task exists");
const ddir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-goslice-"));
await dt!.setup!(ddir);
const recschema = await fs.readFile(path.join(ddir, "internal/tlvschema/recschema.go"), "utf8");
assert.match(recschema, /payload\[loc:end\]/, "slices to the declared end");
assert.ok(!/len\(payload\)/.test(recschema), "pre-fix code does NOT yet clamp to the payload length");
assert.match(recschema, /BUG: a\.Size can exceed/, "flags the unclamped slice as the bug");
assert.ok(
  await fs.stat(path.join(ddir, "internal/tlvschema/recschema_test.go")).then(() => true).catch(() => false),
  "on-disk test present (red→green)",
);
await fs.rm(ddir, { recursive: true, force: true }).catch(() => {});

// --- resolveTasks: Go tasks reachable by id, excluded from the default suite ---
assert.ok(!resolveTasks().some((x) => x.id.startsWith("go-") || x.id === "tlv-attr-slice-panic"), "Go tasks excluded by default");
assert.deepEqual(
  resolveTasks(["go-uint40-decode-bug", "tlv-attr-slice-panic"]).map((x) => x.id).sort(),
  ["go-uint40-decode-bug", "tlv-attr-slice-panic"],
  "resolve when named",
);

process.stdout.write("test-go-tasks: ALL PASS\n");
