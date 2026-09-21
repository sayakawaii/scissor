/**
 * Deterministic test: background shells and await_shell.
 * Covers: a fast command completing inline, a failing exit code, backgrounding
 * with block_until_ms:0, polling a running shell, blocking on a regex pattern,
 * a pattern that never matches, waiting for exit, the mirrored output file with
 * its header/footer, sleeping with no shell_id, and unknown-id errors.
 *
 * Uses `node -e` for the child processes so it behaves the same on Windows and
 * POSIX. No network.
 *
 * Run: node --import tsx scripts/test-shells.mts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  awaitShellTool,
  getShellRegistry,
  killAllShells,
  runShellTool,
  TERMINALS_DIRNAME,
  type ToolContext,
} from "@scissor/core";

const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-shells-"));
const ctx: ToolContext = { workspaceRoot };

/** A `node -e` command line that survives both cmd.exe and /bin/sh quoting. */
const nodeCmd = (js: string) => `node -e "${js}"`;

/** Prints a marker after ~600ms, then exits 0. */
const SLOW_OK = nodeCmd(
  "setTimeout(()=>{console.log('READY-MARKER');process.exit(0)},600);console.log('booting')",
);

// 1. A fast command completes inline with its exit code and output.
{
  const r = await runShellTool.run({ command: nodeCmd("console.log('hello inline')") }, ctx);
  assert.equal(r.isError, false, "successful command is not an error");
  assert.match(r.content, /Exit code: 0/, "exit code reported");
  assert.match(r.content, /hello inline/, "stdout captured");
  assert.match(r.content, /Full output: \.scissor\/terminals\/\d+\.txt/, "mirror path reported");
}

// 2. A non-zero exit is surfaced as an error.
{
  const r = await runShellTool.run({ command: nodeCmd("process.exit(3)") }, ctx);
  assert.equal(r.isError, true, "non-zero exit is an error");
  assert.match(r.content, /Exit code: 3/);
}

// 3. block_until_ms:0 backgrounds the command immediately and hands back an id.
let backgroundId = "";
{
  const started = Date.now();
  const r = await runShellTool.run({ command: SLOW_OK, block_until_ms: 0 }, ctx);
  const elapsed = Date.now() - started;
  assert.equal(r.isError, false, "backgrounding is not an error");
  assert.match(r.content, /still running in the background/, "reported as backgrounded");
  assert.ok(elapsed < 400, `returned promptly (took ${elapsed}ms)`);
  const m = /shell_id "(\d+)"/.exec(r.content);
  assert.ok(m, "a shell id was handed back");
  backgroundId = m![1]!;
}

// 4. is_background:true is equivalent to block_until_ms:0.
{
  const r = await runShellTool.run({ command: SLOW_OK, is_background: true }, ctx);
  assert.match(r.content, /still running in the background/, "is_background backgrounds too");
}

// 5. await_shell blocks until a regex matches the output.
{
  const r = await awaitShellTool.run(
    { shell_id: backgroundId, pattern: "READY-MARKER", block_until_ms: 5000 },
    ctx,
  );
  assert.equal(r.isError, false);
  assert.match(r.content, /READY-MARKER/, "pattern match reported");
}

// 6. await_shell waits for exit when given no pattern.
{
  const r = await awaitShellTool.run({ shell_id: backgroundId, block_until_ms: 5000 }, ctx);
  assert.match(r.content, /Exit code: 0/, "exit observed by await");
}

// 7. A pattern that never matches returns a non-error timeout, not a failure.
{
  const bg = await runShellTool.run(
    { command: nodeCmd("setTimeout(()=>process.exit(0),3000)"), block_until_ms: 0 },
    ctx,
  );
  const id = /shell_id "(\d+)"/.exec(bg.content)![1]!;
  const r = await awaitShellTool.run(
    { shell_id: id, pattern: "NEVER-APPEARS", block_until_ms: 300 },
    ctx,
  );
  assert.equal(r.isError, false, "an unmatched pattern is not an error");
  assert.match(r.content, /did not match within 300ms/);
  getShellRegistry(workspaceRoot).kill(id);
}

// 8. block_until_ms:0 on await_shell is an immediate status check.
{
  const bg = await runShellTool.run(
    { command: nodeCmd("setTimeout(()=>process.exit(0),3000)"), block_until_ms: 0 },
    ctx,
  );
  const id = /shell_id "(\d+)"/.exec(bg.content)![1]!;
  const started = Date.now();
  const r = await awaitShellTool.run({ shell_id: id, block_until_ms: 0 }, ctx);
  assert.ok(Date.now() - started < 300, "immediate check does not block");
  assert.match(r.content, /still running/);
  getShellRegistry(workspaceRoot).kill(id);
}

// 9. The mirror file carries a metadata header and, once exited, a footer.
{
  const r = await runShellTool.run({ command: nodeCmd("console.log('mirrored')") }, ctx);
  const rel = /Full output: (\S+)/.exec(r.content)![1]!;
  const file = path.join(workspaceRoot, rel);
  const text = await fs.readFile(file, "utf8");
  assert.match(text, /^---\n/, "header fence");
  assert.match(text, /\npid: \d+\n/, "pid in header");
  assert.match(text, /\ncommand: node -e /, "command in header");
  assert.match(text, /\nstatus: exited\n/, "status in header");
  assert.match(text, /\nexit_code: 0\n/, "exit code in footer");
  assert.match(text, /\nelapsed_ms: \d+\n/, "elapsed in footer");
  assert.match(text, /mirrored/, "body carries the output");
  assert.ok(rel.startsWith(TERMINALS_DIRNAME.split(path.sep).join("/")), "written under the terminals dir");
}

// 10. await_shell with no shell_id is a plain sleep.
{
  const started = Date.now();
  const r = await awaitShellTool.run({ block_until_ms: 250 }, ctx);
  assert.ok(Date.now() - started >= 200, "actually slept");
  assert.match(r.content, /Waited 250ms/);
}

// 11. A pattern without a shell_id is rejected rather than silently sleeping.
{
  const r = await awaitShellTool.run({ pattern: "x", block_until_ms: 10 }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content, /needs a 'shell_id'/);
}

// 12. An unknown shell id is an error that lists what does exist.
{
  const r = await awaitShellTool.run({ shell_id: "9999", block_until_ms: 10 }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content, /Unknown shell_id "9999"/);
  assert.match(r.content, /Known shells:/);
}

// 13. An empty command is rejected.
{
  const r = await runShellTool.run({ command: "   " }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content, /'command' is required/);
}

// 14. An invalid regex is reported instead of crashing the tool.
{
  const bg = await runShellTool.run(
    { command: nodeCmd("setTimeout(()=>process.exit(0),2000)"), block_until_ms: 0 },
    ctx,
  );
  const id = /shell_id "(\d+)"/.exec(bg.content)![1]!;
  const r = await awaitShellTool.run({ shell_id: id, pattern: "([unclosed", block_until_ms: 100 }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content, /Invalid pattern/);
  getShellRegistry(workspaceRoot).kill(id);
}

killAllShells();
await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
process.stdout.write("test-shells: ALL PASS\n");
