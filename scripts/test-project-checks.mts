/**
 * Deterministic test: unified project-check detection (`detectProjectChecks`).
 * This is the single source of truth shared by the diagnostics tool and the CLI
 * verification loop, so both stay in sync. Covers: typecheck aliases
 * (typecheck / type-check / tsc), lint, test, tsconfig presence, and an empty
 * project. No network, no real npm.
 *
 * Run: node --import tsx scripts/test-project-checks.mts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectProjectChecks } from "@scissor/core";

const mkdir = () => fs.mkdtemp(path.join(os.tmpdir(), "scissor-checks-"));
const rm = (dir: string) => fs.rm(dir, { recursive: true, force: true }).catch(() => {});
const pkg = (dir: string, scripts: Record<string, string>) =>
  fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "t", scripts }));

// 1. `typecheck` + `lint` + `test` scripts all detected.
{
  const dir = await mkdir();
  await pkg(dir, { typecheck: "tsc --noEmit", lint: "eslint .", test: "node t.js" });
  const c = await detectProjectChecks(dir);
  assert.deepEqual(c.typecheck, { label: "typecheck", command: "npm run typecheck" });
  assert.deepEqual(c.lint, { label: "lint", command: "npm run lint" });
  assert.deepEqual(c.test, { label: "test", command: "npm test" });
  assert.equal(c.hasTsconfig, false);
  await rm(dir);
}

// 2. `type-check` alias is recognized as the typecheck check.
{
  const dir = await mkdir();
  await pkg(dir, { "type-check": "tsc --noEmit" });
  const c = await detectProjectChecks(dir);
  assert.deepEqual(c.typecheck, { label: "type-check", command: "npm run type-check" });
  assert.equal(c.lint, undefined);
  await rm(dir);
}

// 3. A `tsc` script is treated as typecheck (superset alias).
{
  const dir = await mkdir();
  await pkg(dir, { tsc: "tsc --noEmit" });
  const c = await detectProjectChecks(dir);
  assert.deepEqual(c.typecheck, { label: "tsc", command: "npm run tsc" });
  await rm(dir);
}

// 4. tsconfig.json presence is reported (for the diagnostics tsc fallback).
{
  const dir = await mkdir();
  await pkg(dir, {});
  await fs.writeFile(path.join(dir, "tsconfig.json"), "{}");
  const c = await detectProjectChecks(dir);
  assert.equal(c.hasTsconfig, true);
  assert.equal(c.typecheck, undefined, "tsconfig alone is not a typecheck script");
  await rm(dir);
}

// 5. Empty project: nothing detected, no throw.
{
  const dir = await mkdir();
  const c = await detectProjectChecks(dir);
  assert.deepEqual(c, { hasTsconfig: false });
  await rm(dir);
}

process.stdout.write("test-project-checks: ALL PASS\n");
