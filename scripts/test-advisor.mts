/**
 * Deterministic test: experience Advisor (doc §5 Phase 3 建议模式).
 *
 * Covers, with no network:
 *  - options are ranked by learned reliability within a state, most reliable
 *    first, and only CONFIDENT cells are advised (thin samples excluded);
 *  - advice is state-scoped: only the matching bucket is considered;
 *  - unreliable options carry a caution naming the top failure signature;
 *  - renderAdviceForPrompt safe-degrades to "" when there is no confident data,
 *    and otherwise frames itself as offline stats ("NOT rules");
 *  - buildSystemPrompt injects the advice block ONLY when given one, proving the
 *    advisor is off-by-default and does not change the prompt otherwise.
 *
 * Run: node --import tsx scripts/test-advisor.mts
 */
import assert from "node:assert/strict";
import {
  adviseOptions,
  aggregateExperience,
  buildSystemPrompt,
  EXPERIENCE_SCHEMA_VERSION,
  formatAdvice,
  renderAdviceForPrompt,
  type ExperienceEvent,
} from "@scissor/core";

let n = 0;
const ts = (i: number): string => `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`;
function ev(
  option: string,
  state: Record<string, string | number | boolean>,
  termination: ExperienceEvent["termination"],
  errorSignature?: string,
): ExperienceEvent {
  return {
    schemaVersion: EXPERIENCE_SCHEMA_VERSION,
    taskId: `t${n}`,
    option: { id: option, version: "m1" },
    state,
    startedAt: ts(n++),
    durationMs: 100,
    termination,
    evidence: errorSignature ? { errorSignature } : {},
    cost: {},
  };
}

// Build a report: in node repos read_file is reliable (6/6), run_shell is flaky
// (1/6, with a repeated failure signature). In python repos there is only a thin
// sample of read_file (not confident).
const events: ExperienceEvent[] = [];
for (let i = 0; i < 6; i++) events.push(ev("read_file", { lang: "node" }, "success"));
events.push(ev("run_shell", { lang: "node" }, "success"));
for (let i = 0; i < 5; i++) events.push(ev("run_shell", { lang: "node" }, "failure", "nonzero exit <x>"));
for (let i = 0; i < 2; i++) events.push(ev("read_file", { lang: "python" }, "success"));

const report = aggregateExperience(events);

// 1. Ranking within the node state: reliable read_file above flaky run_shell.
{
  const advice = adviseOptions(report, { state: { lang: "node" } });
  assert.equal(advice.length, 2, "both confident node options advised");
  assert.equal(advice[0]!.optionId, "read_file", "most reliable ranked first");
  assert.equal(advice[0]!.rank, 1);
  assert.equal(advice[0]!.tier, "reliable");
  assert.equal(advice[1]!.optionId, "run_shell");
  assert.equal(advice[1]!.tier, "unreliable");
  // The flaky option carries a caution naming its top (secret-free) signature.
  assert.ok(advice[1]!.caution && advice[1]!.caution.includes("nonzero exit <x>"), "caution names signature");
}

// 2. State scoping: python bucket has only a thin read_file sample -> no advice.
{
  const advice = adviseOptions(report, { state: { lang: "python" } });
  assert.equal(advice.length, 0, "thin python sample yields no confident advice");
}

// 3. Confidence gate across all states: python read_file (2 samples) excluded.
{
  const all = adviseOptions(report);
  assert.ok(all.every((a) => a.samples >= report.minSamples), "only confident cells advised");
  assert.ok(all.some((a) => a.optionId === "read_file" && a.stateBucket === "lang=node"));
  assert.ok(!all.some((a) => a.stateBucket === "lang=python"), "thin bucket never advised");
}

// 4. Prompt rendering: framed as guidance, not rules; lists options.
{
  const advice = adviseOptions(report, { state: { lang: "node" } });
  const block = renderAdviceForPrompt(advice, { lang: "node" });
  assert.ok(block.includes("Experience-based guidance"), "has header");
  assert.ok(block.includes("NOT rules"), "explicitly not rules");
  assert.ok(block.includes("read_file") && block.includes("run_shell"), "lists options");
}

// 5. Safe-degrade: no confident advice -> empty prompt block (no injection).
{
  const empty = renderAdviceForPrompt([], { lang: "node" });
  assert.equal(empty, "", "no advice -> empty string (safe-degrade)");
  const pyBlock = renderAdviceForPrompt(adviseOptions(report, { state: { lang: "python" } }));
  assert.equal(pyBlock, "", "thin bucket -> empty prompt block");
}

// 6. Off-by-default: buildSystemPrompt only injects the block when given one.
{
  const baseCtx = { workspaceRoot: "/w", platform: "linux", approvalPolicy: "auto" as const };
  const without = buildSystemPrompt(baseCtx);
  assert.ok(!without.includes("Experience-based guidance"), "no injection without advice");

  const block = renderAdviceForPrompt(adviseOptions(report, { state: { lang: "node" } }), { lang: "node" });
  const withAdvice = buildSystemPrompt({ ...baseCtx, experienceAdvice: block });
  assert.ok(withAdvice.includes("Experience-based guidance"), "injected when provided");
  assert.ok(withAdvice.length > without.length, "advice adds to the prompt");

  // Empty/whitespace advice must not add a block.
  const withEmpty = buildSystemPrompt({ ...baseCtx, experienceAdvice: "" });
  assert.equal(withEmpty, without, "empty advice leaves the prompt unchanged");
}

// 7. formatAdvice renders terminal output (and handles the empty case).
{
  const advice = adviseOptions(report, { state: { lang: "node" } });
  const out = formatAdvice(advice, { lang: "node" });
  assert.ok(out.includes("read_file") && out.includes("run_shell"));
  const emptyOut = formatAdvice([], { lang: "node" });
  assert.ok(emptyOut.includes("No confident guidance"), "empty advice has a friendly message");
}

process.stdout.write("test-advisor: ALL PASS\n");
