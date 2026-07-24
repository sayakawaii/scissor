/**
 * Deterministic test: E3 "Estimate" stage (experience/estimator.ts;
 * arXiv:2607.13034 §4.2).
 *
 * The estimator maps a task's wording (+ an optional one-probe hit count) to an
 * operating point x₀ = (difficulty, scope, risk, confidence). It must:
 *  - read localized single-file edits as difficulty 1 / local,
 *  - read broad-scope wording as difficulty 3 / repo,
 *  - default to a cautious middle (2 / cross-file) when cues are weak,
 *  - and lower confidence when a probe reveals a wider footprint than the wording
 *    implies (an Expand candidate) — WITHOUT changing the optimistic estimate.
 *
 * Pure and network-free.
 *
 * Run: node --import tsx scripts/test-estimator.mts
 */
import assert from "node:assert/strict";
import {
  estimateOperatingPoint,
  formatOperatingPoint,
} from "../packages/core/src/experience/estimator.js";

// 1. Localized single-file edit → difficulty 1 / local / low risk, confident.
{
  const op = estimateOperatingPoint({
    query: 'Fix the typo in the heading string in src/components/Header.tsx',
  });
  assert.equal(op.difficulty, 1, "explicit file + local verb/noun → difficulty 1");
  assert.equal(op.scope, "local");
  assert.equal(op.risk, "low");
  assert.ok(op.confidence >= 0.8, "confident on a clearly local task");
}

// 2. A quoted literal + local verb, no path, still reads local.
{
  const op = estimateOperatingPoint({ query: 'Replace the "Submit" label with "Send"' });
  assert.equal(op.difficulty, 1, "quoted literal + local verb → local");
  assert.equal(op.scope, "local");
}

// 3. Broad-scope wording → difficulty 3 / repo / high risk.
{
  for (const q of [
    "Rename the User class everywhere across the codebase",
    "Refactor the database layer",
    "Update every call site of getConfig to pass the new option",
  ]) {
    const op = estimateOperatingPoint({ query: q });
    assert.equal(op.difficulty, 3, `broad-scope → difficulty 3: ${q}`);
    assert.equal(op.scope, "repo");
    assert.equal(op.risk, "high");
  }
}

// 4. Weak/ambiguous cues → cautious middle (difficulty 2 / cross-file), lower conf.
{
  const op = estimateOperatingPoint({ query: "Make the login flow work with the new API" });
  assert.equal(op.difficulty, 2, "no strong cues → difficulty 2");
  assert.equal(op.scope, "cross-file");
  assert.ok(op.confidence <= 0.5, "less confident when cues are weak");
}

// 5. Probe conflict: local wording but many hits → same estimate, lower confidence
//    (flagged as an Expand candidate; the paper keeps the optimistic scope).
{
  const base = estimateOperatingPoint({
    query: "Fix the typo in the label in src/ui/Button.tsx",
  });
  const conflicted = estimateOperatingPoint({
    query: "Fix the typo in the label in src/ui/Button.tsx",
    probeHits: 7,
  });
  assert.equal(conflicted.difficulty, base.difficulty, "difficulty unchanged (still optimistic)");
  assert.ok(conflicted.confidence < base.confidence, "confidence lowered by the probe conflict");
  assert.ok(conflicted.confidence <= 0.35, "flagged as an Expand candidate");
  assert.ok(
    conflicted.rationale.some((r) => /7 hits/.test(r)),
    "rationale explains the probe conflict",
  );
}

// 6. A low probe count does not lower confidence.
{
  const op = estimateOperatingPoint({
    query: "Fix the typo in src/ui/Button.tsx",
    probeHits: 1,
  });
  assert.ok(op.confidence >= 0.8, "single probe hit keeps a confident local estimate");
}

// 7. formatOperatingPoint renders the axes + rationale.
{
  const s = formatOperatingPoint(estimateOperatingPoint({ query: "Refactor the auth module" }));
  assert.match(s, /scope=repo/);
  assert.match(s, /difficulty=3/);
  assert.match(s, /confidence=0\.\d\d/);
}

process.stdout.write("test-estimator: ALL PASS\n");
