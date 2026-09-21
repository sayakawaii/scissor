/**
 * Deterministic test: the `remember` long-term memory tool and its
 * appendUnderLearned helper. No network.
 *
 * Run: node --import tsx scripts/test-remember.mts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendUnderLearned, rememberTool } from "@scissor/core";

// --- appendUnderLearned unit behavior ---
{
  const empty = appendUnderLearned("", "- first");
  assert.ok(empty.includes("## Learned"), "creates Learned section when empty");
  assert.ok(empty.includes("- first"), "adds the bullet");

  const withHeading = appendUnderLearned("## Learned\n\n- a\n", "- b");
  const lines = withHeading.split(/\r?\n/).filter(Boolean);
  assert.deepEqual(lines, ["## Learned", "- a", "- b"], "appends after existing bullets");

  const noHeading = appendUnderLearned("# Notes\n\nsome text\n", "- x");
  assert.ok(noHeading.includes("## Learned"), "adds Learned section when missing");
  assert.ok(noHeading.includes("some text"), "keeps existing content");
}

// --- rememberTool end-to-end against a temp workspace ---
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-mem-"));
  const ctx = { workspaceRoot: root, memoryFile: "SCISSOR_MEMORY.md" };

  const r1 = await rememberTool.run({ fact: "Build with `npm run build`." }, ctx);
  assert.ok(!r1.isError, "first remember ok");
  let mem = await fs.readFile(path.join(root, "SCISSOR_MEMORY.md"), "utf8");
  assert.ok(mem.includes("- Build with `npm run build`."), "fact persisted");

  // Dedup: remembering the same fact does not duplicate it.
  const r2 = await rememberTool.run({ fact: "Build with `npm run build`." }, ctx);
  assert.ok(!r2.isError && /Already/.test(r2.content), "dedup detected");
  mem = await fs.readFile(path.join(root, "SCISSOR_MEMORY.md"), "utf8");
  assert.equal(mem.split("- Build with").length - 1, 1, "not duplicated");

  // A second, distinct fact is appended.
  await rememberTool.run({ fact: "Tests live in scripts/." }, ctx);
  mem = await fs.readFile(path.join(root, "SCISSOR_MEMORY.md"), "utf8");
  assert.ok(mem.includes("- Tests live in scripts/."), "second fact added");

  // Empty fact rejected.
  const r3 = await rememberTool.run({ fact: "   " }, ctx);
  assert.ok(r3.isError, "empty fact rejected");

  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}

process.stdout.write("\x1b[32mtest-remember: ALL PASS\x1b[0m\n");
