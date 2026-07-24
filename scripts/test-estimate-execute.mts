/**
 * Deterministic test: E3 "Execute the minimum viable path" guard (Phase 2;
 * guardrails.ts / arXiv:2607.13034 §4.3).
 *
 * createMinViablePathGuard vetoes broad context-gathering (semantic `retrieve`)
 * ONLY when the run's operating point is a confident, localized single-file edit
 * (difficulty 1 / local / confidence ≥ 0.7). It must:
 *  - skip `retrieve` on a confident local estimate, feeding back a non-error nudge,
 *  - leave `retrieve` alone when the estimate is cross-file / repo / low-confidence
 *    or absent (the safe default, so nothing regresses),
 *  - never touch non-broad tools (read/edit) even on a local estimate.
 *
 * Pure and network-free.
 *
 * Run: node --import tsx scripts/test-estimate-execute.mts
 */
import assert from "node:assert/strict";
import { createMinViablePathGuard } from "../packages/core/src/guardrails.js";
import {
  estimateOperatingPoint,
  type OperatingPoint,
} from "../packages/core/src/experience/estimator.js";
import type { GuardContext, GuardResult, ToolCall } from "../packages/core/src/types.js";

const gctx = {} as GuardContext; // the guard ignores context; only the call + estimate matter.
const call = (name: string): ToolCall => ({ id: "t1", name, arguments: {} });

function run(op: OperatingPoint | undefined, name: string): GuardResult {
  const guard = createMinViablePathGuard(() => op);
  return guard.beforeTool!(call(name), gctx) as GuardResult;
}

const local = estimateOperatingPoint({ query: "Fix the typo in src/ui/Button.tsx" });
assert.equal(local.difficulty, 1, "sanity: the fixture estimates as a local edit");
assert.ok(local.confidence >= 0.7);

// 1. Confident local edit → `retrieve` is skipped with a non-error nudge.
{
  const r = run(local, "retrieve");
  assert.equal(r.allow, false, "retrieve vetoed on a confident local estimate");
  if (r.allow === false) {
    assert.equal(r.reason, "min-viable-path");
    assert.equal(r.result?.isError, false, "fed back as guidance, not an error");
    assert.match(String(r.result?.content), /localized single-file edit/);
  }
}

// 2. Non-broad tools are never gated, even on a local estimate.
for (const name of ["read_file", "edit_file", "write_file", "run_shell", "grep"]) {
  assert.equal(run(local, name).allow, true, `${name} passes through on a local estimate`);
}

// 3. Cross-file estimate (weak cues) → retrieve allowed (may genuinely need it).
{
  const crossFile = estimateOperatingPoint({ query: "Make the login flow work with the new API" });
  assert.equal(crossFile.difficulty, 2);
  assert.equal(run(crossFile, "retrieve").allow, true, "retrieve allowed on a cross-file task");
}

// 4. Repo-wide estimate → retrieve allowed (broad change needs broad context).
{
  const repo = estimateOperatingPoint({ query: "Rename the User class everywhere across the codebase" });
  assert.equal(repo.difficulty, 3);
  assert.equal(run(repo, "retrieve").allow, true, "retrieve allowed on a repo-wide task");
}

// 5. Low-confidence local (probe revealed a wider footprint) → retrieve allowed,
//    so the Expand path can still gather context.
{
  const widened = estimateOperatingPoint({
    query: "Fix the typo in src/ui/Button.tsx",
    probeHits: 7,
  });
  assert.equal(widened.difficulty, 1, "still optimistic scope");
  assert.ok(widened.confidence < 0.7, "but not confident");
  assert.equal(run(widened, "retrieve").allow, true, "retrieve allowed when confidence is low");
}

// 6. No estimate (estimation off) → retrieve allowed. This is the default path,
//    so a normal run with the guard installed but no operating point is untouched.
assert.equal(run(undefined, "retrieve").allow, true, "no estimate → nothing gated");

process.stdout.write("test-estimate-execute: ALL PASS\n");
