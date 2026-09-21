/**
 * Deterministic test: filterFailingStats (--fail <rate> CLI option).
 *
 * Builds a report with aggregateExperience, applies filterFailingStats, and
 * asserts that only cells with successRate strictly below the threshold are
 * kept, sorted ascending by successRate.
 *
 * Run: node --import tsx scripts/test-experience-fail.mts
 */
import assert from "node:assert/strict";
import {
  aggregateExperience,
  filterFailingStats,
  EXPERIENCE_SCHEMA_VERSION,
  type ExperienceEvent,
} from "@scissor/core";

let n = 0;
const ts = (i: number): string => `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`;

function ev(
  option: string,
  version: string,
  state: Record<string, string | number | boolean>,
  termination: ExperienceEvent["termination"],
  extra: Partial<ExperienceEvent> = {},
): ExperienceEvent {
  return {
    schemaVersion: EXPERIENCE_SCHEMA_VERSION,
    taskId: extra.taskId ?? `t${n}`,
    option: { id: option, version },
    state,
    startedAt: extra.startedAt ?? ts(n++),
    durationMs: extra.durationMs ?? 100,
    termination,
    evidence: extra.evidence ?? {},
    cost: extra.cost ?? {},
    finalTaskOutcome: extra.finalTaskOutcome,
  };
}

// Build a report with known success rates across 4 cells:
//   - run_shell@m1  lang=python  → 6/6 = 1.0  (above 0.5)
//   - run_shell@m1  lang=node    → 1/6 ≈ 0.167 (below 0.5)
//   - grep@m1       lang=node    → 0/5 = 0.0   (below 0.5)
//   - grep@m1       lang=python  → 3/5 = 0.6   (above 0.5)
{
  const events: ExperienceEvent[] = [];

  // run_shell@m1, lang=python: 6 successes (successRate=1.0)
  for (let i = 0; i < 6; i++)
    events.push(ev("run_shell", "m1", { lang: "python" }, "success"));

  // run_shell@m1, lang=node: 1 success + 5 failures (successRate=1/6≈0.167)
  events.push(ev("run_shell", "m1", { lang: "node" }, "success"));
  for (let i = 0; i < 5; i++)
    events.push(
      ev("run_shell", "m1", { lang: "node" }, "failure", {
        evidence: { errorSignature: "command failed" },
      }),
    );

  // grep@m1, lang=node: 0 success + 5 failures (successRate=0.0)
  for (let i = 0; i < 5; i++)
    events.push(ev("grep", "m1", { lang: "node" }, "failure"));

  // grep@m1, lang=python: 3 success + 2 failures (successRate=0.6)
  for (let i = 0; i < 3; i++)
    events.push(ev("grep", "m1", { lang: "python" }, "success"));
  for (let i = 0; i < 2; i++)
    events.push(ev("grep", "m1", { lang: "python" }, "failure"));

  const report = aggregateExperience(events, { minSamples: 1 });
  assert.equal(report.stats.length, 4, "4 cells before filtering");

  // Apply filterFailingStats with rate=0.5
  const filtered = filterFailingStats(report, 0.5);

  // Should keep only 2 cells: grep@m1 lang=node (0.0), run_shell@m1 lang=node (~0.167)
  assert.equal(filtered.stats.length, 2, "2 cells below 0.5 threshold");

  // First cell: grep@m1 lang=node — 0.0
  assert.equal(filtered.stats[0]!.optionId, "grep");
  assert.equal(filtered.stats[0]!.stateBucket, "lang=node");
  assert.equal(filtered.stats[0]!.successRate, 0);

  // Second cell: run_shell@m1 lang=node — ~0.167
  assert.equal(filtered.stats[1]!.optionId, "run_shell");
  assert.equal(filtered.stats[1]!.stateBucket, "lang=node");
  assert.ok(filtered.stats[1]!.successRate < 0.5);

  // Verify the ascending sort order
  const rates = filtered.stats.map((s) => s.successRate);
  assert.deepEqual(
    rates,
    [...rates].sort((a, b) => a - b),
    "sorted ascending by successRate",
  );

  // Other report fields are preserved
  assert.equal(filtered.events, report.events);
  assert.equal(filtered.tasks, report.tasks);
  assert.equal(filtered.minSamples, report.minSamples);
}

// Edge case: rate=1 keeps everything (all success rates < 1), rate=0 keeps nothing.
{
  const events: ExperienceEvent[] = [
    ev("read_file", "m1", { lang: "node" }, "success"),
    ev("read_file", "m1", { lang: "node" }, "failure"),
  ];
  const report = aggregateExperience(events, { minSamples: 1 });

  const all = filterFailingStats(report, 1);
  assert.equal(all.stats.length, report.stats.length, "rate=1 keeps all cells");

  const none = filterFailingStats(report, 0);
  assert.equal(none.stats.length, 0, "rate=0 keeps no cells");
}

process.stdout.write("test-experience-fail: ALL PASS\n");
