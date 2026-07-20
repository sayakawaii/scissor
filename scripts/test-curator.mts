/**
 * Deterministic test: Utility Curator (doc §5 Phase 5, controlled curation).
 *
 * Covers, with no network:
 *  - only CONFIDENT cells produce suggestions (thin samples are ignored);
 *  - each action is derived soundly from reliability + final-task contribution:
 *      disable (consistently fails, names the failure signature),
 *      investigate (unreliable but not catastrophic),
 *      archive (reliable locally but NEVER in a successful task),
 *      demote (reliable locally, weak task contribution),
 *      promote (reliable AND strongly tied to task success),
 *      keep (reliable, no final-outcome evidence either way);
 *  - suggestions are sorted most-actionable-first;
 *  - archive/demote require KNOWN final outcomes (finalKnownSamples), so options
 *    lacking verify data are never archived by mistake;
 *  - formatCuration frames itself as suggestions-only ("Nothing is changed").
 *
 * Run: node --import tsx scripts/test-curator.mts
 */
import assert from "node:assert/strict";
import {
  aggregateExperience,
  curateOptions,
  EXPERIENCE_SCHEMA_VERSION,
  formatCuration,
  type CurationRecommendation,
  type ExperienceEvent,
  type FinalTaskOutcome,
} from "@scissor/core";

let n = 0;
const ts = (i: number): string => `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`;
function ev(
  option: string,
  state: Record<string, string | number | boolean>,
  termination: ExperienceEvent["termination"],
  finalTaskOutcome?: FinalTaskOutcome,
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
    ...(finalTaskOutcome ? { finalTaskOutcome } : {}),
  };
}

const events: ExperienceEvent[] = [];
const bucket = { lang: "node" };

// disabler: 6 runs, 1 success (17%) with a repeated failure signature.
events.push(ev("disabler", bucket, "success"));
for (let i = 0; i < 5; i++) events.push(ev("disabler", bucket, "failure", undefined, "nonzero exit <x>"));

// flaky: 6 runs, 3 success (50% -> below unreliableAt? 0.5 is not < 0.5) => 2/6.
events.push(ev("flaky", bucket, "success"));
events.push(ev("flaky", bucket, "success"));
for (let i = 0; i < 4; i++) events.push(ev("flaky", bucket, "failure"));

// archiver: reliable locally (6/6) but tasks it ran in ALWAYS failed overall.
for (let i = 0; i < 6; i++) events.push(ev("archiver", bucket, "success", "failure"));

// demoter: reliable locally (6/6), tasks succeeded only sometimes (2/6 -> 33%).
for (let i = 0; i < 2; i++) events.push(ev("demoter", bucket, "success", "success"));
for (let i = 0; i < 4; i++) events.push(ev("demoter", bucket, "success", "failure"));

// promoter: reliable locally (6/6) AND tasks succeeded (6/6).
for (let i = 0; i < 6; i++) events.push(ev("promoter", bucket, "success", "success"));

// keeper: reliable locally (6/6) but NO final outcome known -> keep, never archive.
for (let i = 0; i < 6; i++) events.push(ev("keeper", bucket, "success"));

// thin: only 2 samples -> not confident -> excluded entirely.
for (let i = 0; i < 2; i++) events.push(ev("thin", bucket, "failure"));

const report = aggregateExperience(events);
const recs = curateOptions(report);
const byId = new Map<string, CurationRecommendation>(recs.map((r) => [r.optionId, r]));

// 1. Thin (non-confident) cell yields no suggestion.
assert.ok(!byId.has("thin"), "non-confident cells are never curated");

// 2. Each confident option gets exactly the expected action.
assert.equal(byId.get("disabler")?.action, "disable", "consistently-failing -> disable");
assert.ok(byId.get("disabler")?.topError?.signature.includes("nonzero exit <x>"), "disable names failure");
assert.ok(byId.get("disabler")?.reason.includes("nonzero exit <x>"), "reason names failure signature");
assert.equal(byId.get("flaky")?.action, "investigate", "middling reliability -> investigate");
assert.equal(byId.get("archiver")?.action, "archive", "reliable but never in a successful task -> archive");
assert.equal(byId.get("demoter")?.action, "demote", "reliable but weak task contribution -> demote");
assert.equal(byId.get("promoter")?.action, "promote", "reliable + task success -> promote");
assert.equal(byId.get("keeper")?.action, "keep", "reliable, no final data -> keep (not archive)");

// 3. archive/demote require KNOWN final outcomes: keeper has finalKnownSamples 0.
assert.equal(byId.get("keeper")?.finalKnownSamples, 0, "keeper has no known final outcomes");
assert.equal(byId.get("archiver")?.finalKnownSamples, 6, "archiver has known final outcomes");
assert.equal(byId.get("archiver")?.finalSuccessRate, 0, "archiver never contributed to success");

// 4. Suggestions sorted most-actionable-first (disable before keep/promote).
const order = recs.map((r) => r.action);
assert.equal(order[0], "disable", "disable sorts first");
assert.ok(order.indexOf("disable") < order.indexOf("keep"), "disable before keep");
assert.ok(order.indexOf("investigate") < order.indexOf("promote"), "investigate before promote");

// 5. Read-only framing: format makes clear nothing is applied automatically.
const out = formatCuration(recs);
assert.ok(out.includes("SUGGESTIONS ONLY"), "header marks suggestions-only");
assert.ok(out.includes("Nothing is changed automatically"), "states nothing is applied");
assert.ok(/permissions and hard constraints are never touched/i.test(out), "permissions untouched");

// 6. Empty report -> friendly, safe message (no crash).
const empty = formatCuration(curateOptions(aggregateExperience([])));
assert.ok(empty.includes("No confident cells to curate"), "empty case handled");

process.stdout.write("test-curator: ALL PASS\n");
