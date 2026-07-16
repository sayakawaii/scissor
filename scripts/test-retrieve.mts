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
import { buildRepoMap, retrieve, retrieveMulti, listSourceFiles, retrieveTool } from "@scissor/core";

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

// --- multi-query (query rewrite) recall ---
// "authentication" alone never appears in the source; loginUser lives in auth.ts.
// A single vague query misses it; a rewritten set of phrasings recovers the file.
const single = await retrieveMulti(root, ["authentication feature"]);
assert.ok(
  !single.some((r) => r.file === "src/auth.ts"),
  "vague single query does not surface auth.ts",
);
const multi = await retrieveMulti(root, ["authentication feature", "loginUser"]);
assert.ok(
  multi.some((r) => r.file === "src/auth.ts"),
  "rewritten queries recover auth.ts",
);

// Merge keeps the best score per file and dedupes files.
const merged = await retrieveMulti(root, ["loadConfig", "apiKey config"]);
const configHits = merged.filter((r) => r.file === "src/config.ts");
assert.equal(configHits.length, 1, "merged results dedupe files");
assert.ok(configHits[0]!.score > 0, "merged file keeps a positive score");

// retrieve() is a thin wrapper over the single-query path (unchanged behavior).
const viaWrapper = await retrieve(root, "loadConfig");
assert.equal(viaWrapper[0]?.file, "src/config.ts", "retrieve wrapper still ranks config.ts");

// --- retrieve tool accepts a `queries` array ---
const toolCtx = { workspaceRoot: root } as Parameters<typeof retrieveTool.run>[1];
const toolRes = await retrieveTool.run(
  { queries: ["authentication feature", "loginUser"] },
  toolCtx,
);
assert.ok(!toolRes.isError, "tool accepts queries array");
assert.match(String(toolRes.content), /auth\.ts/, "tool surfaces auth.ts from rewritten queries");

// Empty input is a clean error, not a throw.
const emptyRes = await retrieveTool.run({}, toolCtx);
assert.ok(emptyRes.isError, "tool errors when neither query nor queries provided");

await fs.rm(root, { recursive: true, force: true }).catch(() => {});
process.stdout.write("\x1b[32mtest-retrieve: ALL PASS\x1b[0m\n");
