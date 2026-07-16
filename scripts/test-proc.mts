/**
 * Deterministic test: the unified subprocess runner `runProcess`.
 * Covers: stdout/stderr capture + combined output, non-zero exit code,
 * timeout (timedOut flag + kill), maxOutput truncation, and abort via signal.
 * This is the single spawn path shared by run_shell, diagnostics, and self/repo,
 * so a regression here would surface in all three. No network.
 *
 * Uses temp .mjs scripts (run as `node file.mjs`) to avoid cross-platform
 * nested-quote issues with `node -e`.
 *
 * Run: node --import tsx scripts/test-proc.mts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProcess } from "@scissor/core";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-proc-"));
const script = async (name: string, body: string): Promise<string> => {
  await fs.writeFile(path.join(dir, name), body);
  return `node ${name}`;
};

// 1. Captures stdout, stderr, combined output (arrival order) and exit code 0.
{
  const cmd = await script(
    "io.mjs",
    "process.stdout.write('OUT');process.stderr.write('ERR');\n",
  );
  const r = await runProcess(cmd, { cwd: dir });
  assert.equal(r.started, true);
  assert.equal(r.code, 0);
  assert.equal(r.timedOut, false);
  assert.equal(r.truncated, false);
  assert.match(r.stdout, /OUT/);
  assert.match(r.stderr, /ERR/);
  assert.match(r.output, /OUT/);
  assert.match(r.output, /ERR/);
}

// 2. Non-zero exit code is reported.
{
  const cmd = await script("exit3.mjs", "process.exit(3);\n");
  const r = await runProcess(cmd, { cwd: dir });
  assert.equal(r.started, true);
  assert.equal(r.code, 3);
}

// 3. Timeout kills the process and sets timedOut (code null).
{
  const cmd = await script("sleep.mjs", "setTimeout(() => {}, 10000);\n");
  const start = Date.now();
  const r = await runProcess(cmd, { cwd: dir, timeoutMs: 300 });
  assert.equal(r.timedOut, true, "should have timed out");
  assert.equal(r.code, null, "killed process has null exit code");
  assert.ok(Date.now() - start < 5000, "should return promptly after timeout");
}

// 4. maxOutput truncates the combined output.
{
  const cmd = await script("big.mjs", "process.stdout.write('x'.repeat(5000));\n");
  const r = await runProcess(cmd, { cwd: dir, maxOutput: 100 });
  assert.equal(r.truncated, true, "output should be truncated");
  assert.equal(r.output.length, 100, "output capped at maxOutput");
}

// 5. No cap by default: full output is retained.
{
  const cmd = await script("big2.mjs", "process.stdout.write('y'.repeat(5000));\n");
  const r = await runProcess(cmd, { cwd: dir });
  assert.equal(r.truncated, false);
  assert.equal(r.stdout.length, 5000);
}

// 6. Abort via signal kills the process.
{
  const cmd = await script("sleep2.mjs", "setTimeout(() => {}, 10000);\n");
  const controller = new AbortController();
  const p = runProcess(cmd, { cwd: dir, timeoutMs: 10000, signal: controller.signal });
  setTimeout(() => controller.abort(), 200);
  const r = await p;
  assert.equal(r.code, null, "aborted process has null exit code");
  assert.equal(r.timedOut, false, "abort is not a timeout");
}

await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
process.stdout.write("test-proc: ALL PASS\n");
