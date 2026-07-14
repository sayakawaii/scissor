/**
 * Deterministic test: the diagnostics (type-checker feedback) tool.
 * Covers: parsing tsc-style diagnostics, filtering by path, a clean run,
 * `checker` selection (typecheck vs lint), the user-controlled
 * SCISSOR_DIAGNOSTICS_COMMAND env override, and the "no checker detected"
 * fallback. Crucially, the tool takes NO model-supplied command (it is not an
 * arbitrary-exec side-channel) — everything is driven by project scripts / env.
 * Uses small node scripts run relative to the workspace, so no real tsc/network.
 *
 * Run: node --import tsx scripts/test-diagnostics.mts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { diagnosticsTool } from "@scissor/core";

const ctx = (dir: string) => ({ workspaceRoot: dir });
const mkdir = () => fs.mkdtemp(path.join(os.tmpdir(), "scissor-diag-"));
const rm = (dir: string) => fs.rm(dir, { recursive: true, force: true }).catch(() => {});

// 1. Auto-detects the `typecheck` script, parses two diagnostics, filters by path.
{
  const dir = await mkdir();
  await fs.writeFile(
    path.join(dir, "diag.mjs"),
    [
      "console.log('src/a.ts(3,5): error TS2322: Type X is not assignable to Y.');",
      "console.log('src/b.ts(10,1): warning TS6133: unused var.');",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "t", scripts: { typecheck: "node diag.mjs" } }),
  );

  const res = await diagnosticsTool.run({}, ctx(dir));
  assert.equal(res.isError ?? false, false);
  assert.match(res.content, /npm run typecheck/);
  assert.match(res.content, /reported 2 diagnostic\(s\)/);
  assert.match(res.content, /src\/a\.ts:3:5 error TS2322: Type X/);
  assert.match(res.content, /src\/b\.ts:10:1 warning TS6133/);

  const filtered = await diagnosticsTool.run({ path: "a.ts" }, ctx(dir));
  assert.match(filtered.content, /reported 1 diagnostic/);
  assert.match(filtered.content, /a\.ts/);
  assert.doesNotMatch(filtered.content, /b\.ts/);

  await rm(dir);
}

// 2. Clean run (exit 0, no output) -> "No diagnostics".
{
  const dir = await mkdir();
  await fs.writeFile(path.join(dir, "ok.mjs"), "// no output\n");
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "t", scripts: { typecheck: "node ok.mjs" } }),
  );
  const res = await diagnosticsTool.run({}, ctx(dir));
  assert.match(res.content, /No diagnostics/);
  await rm(dir);
}

// 3. `checker: "lint"` selects the lint script over typecheck.
{
  const dir = await mkdir();
  await fs.writeFile(path.join(dir, "tc.mjs"), "console.log('a.ts(1,1): error TS1: tc');\n");
  await fs.writeFile(path.join(dir, "ln.mjs"), "console.log('a.ts(2,2): warning TS2: lint');\n");
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "t", scripts: { typecheck: "node tc.mjs", lint: "node ln.mjs" } }),
  );
  const res = await diagnosticsTool.run({ checker: "lint" }, ctx(dir));
  assert.match(res.content, /npm run lint/);
  assert.match(res.content, /warning TS2: lint/);
  assert.doesNotMatch(res.content, /tc/);
  await rm(dir);
}

// 4. User-controlled SCISSOR_DIAGNOSTICS_COMMAND env override (not model input).
{
  const dir = await mkdir();
  await fs.writeFile(path.join(dir, "env.mjs"), "console.log('z.ts(9,9): error TS999: from env');\n");
  process.env.SCISSOR_DIAGNOSTICS_COMMAND = "node env.mjs";
  try {
    const res = await diagnosticsTool.run({}, ctx(dir));
    assert.match(res.content, /error TS999: from env/);
  } finally {
    delete process.env.SCISSOR_DIAGNOSTICS_COMMAND;
  }
  await rm(dir);
}

// 5. No checker detected -> graceful, non-error guidance.
{
  const dir = await mkdir();
  const res = await diagnosticsTool.run({}, ctx(dir));
  assert.equal(res.isError ?? false, false);
  assert.match(res.content, /No type-checker detected/);
  await rm(dir);
}

// 6. No arbitrary-command escape hatch: a `command` arg is ignored (not exec'd).
{
  const dir = await mkdir();
  await fs.writeFile(path.join(dir, "pwned.mjs"), "console.log('PWNED');\n");
  // Even if a model tried to smuggle a command, it must be ignored.
  const res = await diagnosticsTool.run(
    { command: "node pwned.mjs" } as Record<string, unknown>,
    ctx(dir),
  );
  assert.doesNotMatch(res.content, /PWNED/, "free-form command must not be executed");
  assert.match(res.content, /No type-checker detected/);
  await rm(dir);
}

// 7. It is read-only (parallel-safe, no approval).
assert.equal(diagnosticsTool.mutating, false);

process.stdout.write("test-diagnostics: ALL PASS\n");
