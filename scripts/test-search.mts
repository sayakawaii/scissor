/**
 * Deterministic test: grep and glob now share one ignore policy (fs-scan) that
 * honors .gitignore plus the default ignore superset. Before this refactor grep
 * used a 4-entry ignore list and did NOT read .gitignore, so it would match
 * files under gitignored dirs and dirs like build/ — those assertions would fail
 * against the old grep. No network.
 *
 * Run: node --import tsx scripts/test-search.mts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { grepTool, globTool } from "@scissor/core";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-search-"));
const write = async (rel: string, content: string) => {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
};
const ctx = { workspaceRoot: dir };

const MARKER = "NEEDLE_TOKEN";
await write(".gitignore", "secret/\n");
await write("src/found.ts", `export const a = "${MARKER}";\n`);
await write("secret/hidden.ts", `export const b = "${MARKER}";\n`); // gitignored
await write("build/out.js", `const c = "${MARKER}";\n`); // default-ignored dir

// 1. grep honors .gitignore and the default ignore superset.
{
  const res = await grepTool.run({ pattern: MARKER }, ctx);
  assert.equal(res.isError ?? false, false);
  assert.match(res.content, /src[/\\]found\.ts/, "should find the tracked source file");
  assert.doesNotMatch(res.content, /secret/, "must skip .gitignored dir (was matched before)");
  assert.doesNotMatch(res.content, /build/, "must skip build/ via default ignores");
}

// 2. grep with an include glob still works and stays filtered by ignores.
{
  const res = await grepTool.run({ pattern: MARKER, include: "**/*.ts" }, ctx);
  assert.match(res.content, /src[/\\]found\.ts/);
  assert.doesNotMatch(res.content, /secret/);
}

// 3. glob shares the same ignore policy.
{
  const res = await globTool.run({ pattern: "**/*.ts" }, ctx);
  assert.match(res.content, /src[/\\]found\.ts/);
  assert.doesNotMatch(res.content, /secret/, "glob must skip .gitignored dir too");
}

await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
process.stdout.write("test-search: ALL PASS\n");
