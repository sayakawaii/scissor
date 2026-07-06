/**
 * Deterministic test: repo map + heuristic retrieval + .gitignore handling.
 * No network required.
 *
 * Run: node --import tsx scripts/test-retrieve.mts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRepoMap, retrieve, listSourceFiles } from "@scissor/core";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-idx-"));

async function write(rel: string, content: string) {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

await write(
  "src/config.ts",
  `export interface AppConfig { apiKey: string }\n` +
    `export function loadConfig() {\n  // load the api key from the config file\n  return { apiKey: process.env.API_KEY };\n}\n`,
);
await write(
  "src/auth.ts",
  `export function loginUser(name: string) {\n  return name;\n}\n`,
);
await write("src/util.ts", `export function unrelatedHelper() { return 42; }\n`);
await write(".gitignore", "ignored/\n");
await write("ignored/secret.ts", `export const secret = "do not index";\n`);
await write("node_modules/dep/index.js", `module.exports = 1;\n`);

// --- listSourceFiles respects ignores ---
const files = await listSourceFiles(root);
assert.ok(files.includes("src/config.ts"), "lists source files");
assert.ok(!files.some((f) => f.includes("node_modules")), "excludes node_modules");
assert.ok(!files.some((f) => f.includes("ignored/")), "respects .gitignore");

// --- repo map contains symbols ---
const map = await buildRepoMap(root);
assert.ok(map.includes("loadConfig"), "repo map lists loadConfig symbol");
assert.ok(map.includes("loginUser"), "repo map lists loginUser symbol");
assert.ok(map.includes("config.ts"), "repo map lists files");
assert.ok(!map.includes("secret"), "repo map excludes ignored files");

// --- retrieve ranks the right file first ---
const results = await retrieve(root, "where are api keys loaded from config");
assert.ok(results.length > 0, "retrieve returns results");
assert.equal(results[0]?.file, "src/config.ts", "config.ts ranked first");
assert.ok(
  results[0]!.snippets.some((s) => /api|config/i.test(s.text)),
  "returns matching snippet",
);

await fs.rm(root, { recursive: true, force: true }).catch(() => {});
process.stdout.write("\x1b[32mtest-retrieve: ALL PASS\x1b[0m\n");
