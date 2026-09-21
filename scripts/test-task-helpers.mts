/**
 * Deterministic test: the shared eval/bench task helpers. These back both the
 * eval suite (tasks.ts) and the bench suite (bench-tasks.ts) after de-duping
 * their previously identical private copies, so a regression here would break
 * task setup/scoring across both suites. No network.
 *
 * Run: node --import tsx scripts/test-task-helpers.mts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exists, read, runNode, write } from "../packages/cli/src/eval/task-helpers.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-helpers-"));

// 1. write -> exists -> read round trip, including nested dirs.
{
  assert.equal(await exists(dir, "nested/file.txt"), false);
  await write(dir, "nested/file.txt", "hello helpers");
  assert.equal(await exists(dir, "nested/file.txt"), true);
  assert.equal(await read(dir, "nested/file.txt"), "hello helpers");
}

// 2. runNode runs a script and returns trimmed combined output + ok=true.
{
  await write(dir, "ok.js", "console.log('RESULT_42');\n");
  const r = await runNode(dir, "ok.js");
  assert.equal(r.ok, true);
  assert.equal(r.out, "RESULT_42");
}

// 3. runNode reports failure (non-zero exit) and captures stderr.
{
  await write(dir, "bad.js", "console.error('BOOM'); process.exit(1);\n");
  const r = await runNode(dir, "bad.js");
  assert.equal(r.ok, false);
  assert.match(r.out, /BOOM/);
}

await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
process.stdout.write("test-task-helpers: ALL PASS\n");
