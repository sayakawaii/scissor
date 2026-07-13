/**
 * Deterministic test: the diagnostics (type-checker feedback) tool.
 * Covers: parsing tsc-style diagnostics from a checker command, filtering by
 * path, a clean (no-diagnostics) run, auto-detection of a `typecheck` npm
 * script, and the "no checker detected" fallback. Uses small script files run
 * relative to the workspace (no quoting/spaces), so there's no real tsc/network.
 *
 * Run: node --import tsx scripts/test-diagnostics.mts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { diagnosticsTool } from "@scissor/core";

const ctx = (dir: string) => ({ workspaceRoot: dir });

// 1. Parses tsc-style output from an explicit command; counts + filters.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-diag-"));
  await fs.writeFile(
    path.join(dir, "fake.mjs"),
    [
      "console.log('src/a.ts(3,5): error TS2322: Type X is not assignable to Y.');",
      "console.log('src/b.ts(10,1): warning TS6133: unused var.');",
    ].join("\n"),
  );
  const res = await diagnosticsTool.run({ command: "node fake.mjs" }, ctx(dir));
  assert.equal(res.isError ?? false, false);
  assert.match(res.content, /reported 2 diagnostic\(s\)/);
  assert.match(res.content, /src\/a\.ts:3:5 error TS2322: Type X/);
  assert.match(res.content, /src\/b\.ts:10:1 warning TS6133/);

  const filtered = await diagnosticsTool.run({ command: "node fake.mjs", path: "a.ts" }, ctx(dir));
  assert.match(filtered.content, /reported 1 diagnostic/);
  assert.match(filtered.content, /a\.ts/);
  assert.doesNotMatch(filtered.content, /b\.ts/);

  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// 2. Clean run (exit 0, no output) -> "No diagnostics".
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-diag-"));
  await fs.writeFile(path.join(dir, "empty.mjs"), "// no output\n");
  const res = await diagnosticsTool.run({ command: "node empty.mjs" }, ctx(dir));
  assert.match(res.content, /No diagnostics/);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// 3. Auto-detects a `typecheck` npm script when no command is given.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-diag-"));
  await fs.writeFile(
    path.join(dir, "diag.mjs"),
    "console.log('foo.ts(1,1): error TS1000: boom');\n",
  );
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "t", scripts: { typecheck: "node diag.mjs" } }),
  );
  const res = await diagnosticsTool.run({}, ctx(dir));
  assert.match(res.content, /npm run typecheck/, "detected the typecheck script");
  assert.match(res.content, /foo\.ts:1:1 error TS1000/);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// 4. No checker detected -> graceful, non-error guidance.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-diag-"));
  const res = await diagnosticsTool.run({}, ctx(dir));
  assert.equal(res.isError ?? false, false);
  assert.match(res.content, /No type-checker detected/);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// 5. It is read-only (parallel-safe, no approval).
assert.equal(diagnosticsTool.mutating, false);

process.stdout.write("test-diagnostics: ALL PASS\n");
