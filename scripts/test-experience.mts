/**
 * Deterministic test: OaK-inspired experience layer (doc §8 acceptance criteria).
 *
 * Covers, with no network:
 *  - the offline model identifies an option that is clearly MORE RELIABLE in one
 *    state bucket than another, and only when both buckets are confident (§8.5);
 *  - aggregation is deterministic regardless of input ordering (§8.4);
 *  - error signatures are secret-free (no paths / quoted contents / numbers)(§6);
 *  - non-capability terminations (guardrail / cancelled / budget) are EXCLUDED
 *    from success statistics, not counted as failures (§7 "数据污染");
 *  - events from an unknown schema version are ignored (§5 versioned schema);
 *  - the CLI trace -> experience mapper carries state, versions per model, and
 *    still maps legacy traces that predate trace normalization.
 *
 * Run: node --import tsx scripts/test-experience.mts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  aggregateExperience,
  deriveStateBucket,
  EXPERIENCE_SCHEMA_VERSION,
  normalizeErrorSignature,
  wilsonInterval,
  type ExperienceEvent,
} from "@scissor/core";
import {
  experienceReportFromDir,
  toExperienceEvents,
} from "../packages/cli/src/experience-report.js";
import type { TraceEvent } from "../packages/cli/src/trace.js";

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

// 1. State-conditioned reliability: run_shell is reliable in node repos, flaky
//    in python repos. Both buckets are confident (>= 5 samples).
{
  const events: ExperienceEvent[] = [];
  for (let i = 0; i < 6; i++) events.push(ev("run_shell", "m1", { lang: "node" }, "success"));
  events.push(ev("run_shell", "m1", { lang: "python" }, "success"));
  for (let i = 0; i < 5; i++)
    events.push(
      ev("run_shell", "m1", { lang: "python" }, "failure", {
        evidence: { errorSignature: "command failed: <x>" },
      }),
    );

  const report = aggregateExperience(events);
  assert.equal(report.stateConditioned.length, 1, "one state-conditioned finding");
  const f = report.stateConditioned[0]!;
  assert.equal(f.optionId, "run_shell");
  assert.equal(f.betterBucket, "lang=node");
  assert.equal(f.worseBucket, "lang=python");
  assert.ok(f.betterRate > f.worseRate, "better bucket has higher success rate");
  assert.ok(f.betterRate - f.worseRate >= 0.25, "gap exceeds threshold");

  const nodeCell = report.stats.find(
    (s) => s.optionId === "run_shell" && s.stateBucket === "lang=node",
  )!;
  const pyCell = report.stats.find(
    (s) => s.optionId === "run_shell" && s.stateBucket === "lang=python",
  )!;
  assert.equal(nodeCell.successes, 6);
  assert.equal(nodeCell.samples, 6);
  assert.ok(nodeCell.confident);
  assert.equal(pyCell.successes, 1);
  assert.equal(pyCell.samples, 6);
  assert.ok(pyCell.successRate < 0.25);
  // The flaky bucket surfaces its (secret-free) failure signature.
  assert.equal(pyCell.topErrors[0]?.signature, "command failed: <x>");
  assert.equal(pyCell.topErrors[0]?.count, 5);
}

// 2. Low-sample buckets are flagged and never produce a state-conditioned claim.
{
  const events: ExperienceEvent[] = [
    ev("grep", "m1", { lang: "node" }, "success"),
    ev("grep", "m1", { lang: "node" }, "success"),
    ev("grep", "m1", { lang: "python" }, "failure"),
  ];
  const report = aggregateExperience(events);
  assert.ok(report.stats.every((s) => !s.confident), "3 total samples -> none confident");
  assert.equal(report.stateConditioned.length, 0, "no finding without confident buckets");
}

// 3. Determinism: shuffling the input yields byte-identical aggregation.
{
  const base: ExperienceEvent[] = [];
  for (let i = 0; i < 6; i++) base.push(ev("edit_file", "m1", { lang: "node" }, "success"));
  for (let i = 0; i < 4; i++) base.push(ev("edit_file", "m1", { lang: "node" }, "failure"));
  const shuffled = [...base].reverse();
  const a = JSON.stringify(aggregateExperience(base));
  const b = JSON.stringify(aggregateExperience(shuffled));
  assert.equal(a, b, "aggregation is order-independent");
}

// 4. Non-capability terminations are excluded from the success rate, not failed.
{
  const events: ExperienceEvent[] = [
    ev("write_file", "m1", { lang: "node" }, "success"),
    ev("write_file", "m1", { lang: "node" }, "success"),
    ev("write_file", "m1", { lang: "node" }, "guardrail"),
    ev("write_file", "m1", { lang: "node" }, "cancelled"),
    ev("write_file", "m1", { lang: "node" }, "budget"),
  ];
  const report = aggregateExperience(events);
  const cell = report.stats.find((s) => s.optionId === "write_file")!;
  assert.equal(cell.samples, 2, "only success/failure count toward samples");
  assert.equal(cell.successes, 2);
  assert.equal(cell.failures, 0);
  assert.equal(cell.excluded, 3, "guardrail/cancelled/budget excluded");
  assert.equal(cell.successRate, 1);
}

// 5. Unknown schema versions are ignored.
{
  const good = ev("read_file", "m1", { lang: "node" }, "success");
  const stale = { ...ev("read_file", "m1", { lang: "node" }, "success"), schemaVersion: 0 } as unknown as ExperienceEvent;
  const report = aggregateExperience([good, stale]);
  assert.equal(report.events, 1, "stale-schema event dropped");
}

// 6. Per-version isolation: same option, different model versions -> separate cells.
{
  const events = [
    ev("run_shell", "m1", { lang: "node" }, "success"),
    ev("run_shell", "m2", { lang: "node" }, "failure"),
  ];
  const report = aggregateExperience(events);
  const cells = report.stats.filter((s) => s.optionId === "run_shell");
  assert.equal(cells.length, 2, "stats isolated per option version");
  assert.deepEqual(cells.map((c) => c.version).sort(), ["m1", "m2"]);
}

// 7. Error signature normalization is secret-free and low-cardinality.
{
  const posix = normalizeErrorSignature("Cannot find module '/home/alice/secret/app.js'");
  assert.ok(posix && posix.includes("Cannot find module"));
  assert.ok(posix && !posix.includes("secret") && !posix.includes("alice"), "no path leak");

  const win = normalizeErrorSignature("Error reading C:\\Users\\bob\\token.txt at line 42");
  assert.ok(win && !win.includes("token.txt") && !win.includes("bob"), "no windows path leak");
  assert.ok(win && !/\b42\b/.test(win), "numbers normalized");

  // Two different module identifiers collapse to one signature (low cardinality).
  const a = normalizeErrorSignature("Cannot find module 'left-pad'");
  const b = normalizeErrorSignature("Cannot find module 'is-odd'");
  assert.equal(a, b, "differing identifiers share one signature");

  assert.equal(normalizeErrorSignature(""), undefined);
  assert.equal(normalizeErrorSignature(undefined), undefined);
}

// 8. deriveStateBucket is stable regardless of key insertion order.
{
  const k1 = deriveStateBucket({ lang: "node", size: "sm", tdd: true });
  const k2 = deriveStateBucket({ tdd: true, size: "sm", lang: "node" });
  assert.equal(k1, k2, "bucket key is order-independent");
  assert.equal(deriveStateBucket({}), "-");
  assert.equal(deriveStateBucket(undefined), "-");
}

// 9. Wilson interval sanity.
{
  const wide = wilsonInterval(1, 2);
  const tight = wilsonInterval(50, 100);
  assert.ok(wide.high - wide.low > tight.high - tight.low, "small n -> wider interval");
  assert.deepEqual(wilsonInterval(0, 0), { low: 0, high: 0 });
}

// 10. CLI mapper: trace -> experience events carries state, versions per model,
//     attaches session-level verification, and still maps legacy tool events.
{
  const trace: TraceEvent[] = [
    {
      ts: ts(0),
      type: "session-start",
      schemaVersion: EXPERIENCE_SCHEMA_VERSION,
      sessionId: "sess-1",
      model: "deepseek-chat",
      state: { lang: "node", pkg: "npm" },
    },
    // Normalized tool event with an explicit termination + signature.
    { ts: ts(1), type: "tool", name: "run_shell", ok: false, ms: 30, termination: "failure", errorSignature: "boom <x>" },
    // Legacy tool event (no termination field) -> derived from ok.
    { ts: ts(2), type: "tool", name: "read_file", ok: true, ms: 5 },
    { ts: ts(3), type: "verify", ok: true, summary: "typecheck ok" },
  ];
  const events = toExperienceEvents(trace);
  assert.equal(events.length, 2, "two tool events mapped");
  assert.ok(events.every((e) => e.taskId === "sess-1"));
  assert.ok(events.every((e) => e.option.version === "deepseek-chat"), "version = session model");
  assert.deepEqual(events[0]!.state, { lang: "node", pkg: "npm" });
  assert.ok(events.every((e) => e.finalTaskOutcome === "success"), "final outcome from verify");
  assert.ok(events.every((e) => e.evidence.verificationPassed === true));

  const shell = events.find((e) => e.option.id === "run_shell")!;
  assert.equal(shell.termination, "failure");
  assert.equal(shell.evidence.errorSignature, "boom <x>");
  const read = events.find((e) => e.option.id === "read_file")!;
  assert.equal(read.termination, "success", "legacy ok:true -> success");
}

// 11. End-to-end over JSONL files on disk (experienceReportFromDir).
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-exp-"));
  const writeSession = async (name: string, lines: TraceEvent[]) => {
    await fs.writeFile(path.join(dir, name), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  };
  const sessionLines = (id: string, oks: boolean[]): TraceEvent[] => [
    { ts: ts(0), type: "session-start", schemaVersion: EXPERIENCE_SCHEMA_VERSION, sessionId: id, model: "m1", state: { lang: "node" } },
    ...oks.map((ok, i): TraceEvent => ({
      ts: ts(i + 1),
      type: "tool",
      name: "run_shell",
      ok,
      ms: 20,
      termination: ok ? "success" : "failure",
      ...(ok ? {} : { errorSignature: "nonzero exit <x>" }),
    })),
  ];
  await writeSession("a.jsonl", sessionLines("a", [true, true, true]));
  await writeSession("b.jsonl", sessionLines("b", [true, true, false]));
  // A malformed file must not crash the report.
  await fs.writeFile(path.join(dir, "c.jsonl"), "{ not json\n");

  const report = await experienceReportFromDir(dir);
  assert.equal(report.tasks, 2, "two sessions aggregated");
  const cell = report.stats.find((s) => s.optionId === "run_shell" && s.stateBucket === "lang=node")!;
  assert.equal(cell.samples, 6);
  assert.equal(cell.successes, 5);
  assert.equal(cell.failures, 1);
  assert.ok(cell.confident, "6 samples >= min");

  // min-samples override flips the confidence flag.
  const strict = await experienceReportFromDir(dir, { minSamples: 100 });
  const strictCell = strict.stats.find((s) => s.optionId === "run_shell")!;
  assert.ok(!strictCell.confident, "min-samples override respected");

  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

process.stdout.write("test-experience: ALL PASS\n");
