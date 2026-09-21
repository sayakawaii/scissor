/**
 * Deterministic test for the provider-comparison benchmark pipeline.
 *
 * The benchmark's whole value is that a third party can trust the numbers, so
 * the aggregation and report path is pinned here against synthetic run data
 * with hand-checked arithmetic: Wilson intervals, cost math, passes-per-dollar,
 * ACRR, the significance verdict, and the Markdown rendering.
 *
 * Two properties matter more than the rest and are asserted directly:
 *   - the report refuses to declare a winner when the confidence intervals
 *     overlap, and says "NOT statistically significant" in those words;
 *   - cost is withheld entirely when any attempt was unpriced, so a partially
 *     priced arm can never produce a flattering passes-per-dollar number.
 *
 * Also guards the leak surface: raw per-task detail (which carries temp-dir
 * paths) must never reach the committed artifact.
 *
 * No network, no provider keys: every input is a literal.
 *
 * Run: node --import tsx scripts/test-benchmark.mts
 */
import assert from "node:assert/strict";
import os from "node:os";
import {
  BENCHMARK_SCHEMA_VERSION,
  buildBenchmarkReport,
  compareArms,
  formatBenchmarkMarkdown,
  summarizeArm,
  type ArmSpec,
  type BenchmarkProvenance,
} from "../packages/cli/src/eval/matrix.js";
import { parseArm, resolveTaskSet } from "../packages/cli/src/commands/benchmark.js";
import { estimateCost } from "../packages/cli/src/eval/runner.js";
import type { TaskResult } from "../packages/cli/src/eval/runner.js";
import { priceFor } from "../packages/cli/src/trace-report.js";

const NANO = "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B";
const SUPER = "nvidia/nemotron-3-super-120b-a12b";
const ULTRA = "nvidia/Nemotron-3-Ultra-550b-a55b";
const SONNET = "claude-sonnet-4-20250514";

/** A temp path of the kind eval `detail` strings really contain. */
const LEAKY_DETAIL = "checked C:\\Users\\someone\\AppData\\Local\\Temp\\scissor-eval-a1b2c3\\out.txt";

/**
 * Independent restatement of the Wilson score interval (95%, z=1.96), written
 * from the formula rather than imported, so the production implementation is
 * checked against real math instead of against itself.
 */
function refWilson(successes: number, n: number): [number, number] {
  const z = 1.96;
  const z2 = z * z;
  const p = successes / n;
  const d = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / d;
  const margin = (z / d) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

function close(actual: number, expected: number, eps = 1e-6, msg = ""): void {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `${msg} expected ~${expected}, got ${actual} (diff ${Math.abs(actual - expected)})`,
  );
}

let n = 0;
function mk(taskId: string, pass: boolean, extra: Partial<TaskResult> = {}): TaskResult {
  return {
    taskId,
    title: taskId,
    tags: [],
    pass,
    detail: LEAKY_DETAIL,
    turns: 4,
    elapsedMs: 1000 + n++,
    timedOut: false,
    ...extra,
  };
}

/** Every attempt bills the same tokens, so per-arm cost differs only by price. */
const TOKENS = { promptTokens: 100_000, completionTokens: 10_000 };

function priced(model: string, taskId: string, pass: boolean, extra: Partial<TaskResult> = {}) {
  const costUsd = estimateCost(model, TOKENS.promptTokens, TOKENS.completionTokens);
  assert.ok(costUsd !== undefined, `expected a price for ${model}`);
  return mk(taskId, pass, { ...TOKENS, costUsd, ...extra });
}

// --- 1. Nemotron models must be priced, or the whole cost view is empty ------
// This is the bug that motivated the pricing entries: an unpriced model silently
// drops out of every cost column.
{
  for (const [model, input, output] of [
    [NANO, 0.06, 0.24],
    [SUPER, 0.3, 0.9],
    [ULTRA, 1, 3],
  ] as const) {
    const p = priceFor(model);
    assert.ok(p, `${model} must have a price entry`);
    assert.equal(p.inputPer1M, input, `${model} input price`);
    assert.equal(p.outputPer1M, output, `${model} output price`);
  }
  // Model ids reach us from config and CLI flags where casing drifts.
  assert.deepEqual(priceFor(NANO.toLowerCase()), priceFor(NANO), "price lookup is case-tolerant");

  // 100k in @ $0.06/M + 10k out @ $0.24/M = $0.006 + $0.0024
  close(estimateCost(NANO, 100_000, 10_000)!, 0.0084, 1e-9, "nano cost:");
  close(estimateCost(SONNET, 100_000, 10_000)!, 0.45, 1e-9, "sonnet cost:");
  assert.equal(estimateCost("no-such-model-xyz", 1000, 1000), undefined);
}

// --- 2. Per-arm aggregation: pass rate, Wilson CI, tokens, turns, cost -------
const nanoSpec: ArmSpec = { id: "nemotron-nano", provider: "nebius", model: NANO };
const sonnetSpec: ArmSpec = { id: "sonnet", provider: "claude", model: SONNET };

// 2 iterations x 3 tasks. nano passes 3/6, sonnet 5/6.
const nanoArm = summarizeArm(nanoSpec, [
  [priced(NANO, "t1", true), priced(NANO, "t2", true), priced(NANO, "t3", false)],
  [priced(NANO, "t1", true), priced(NANO, "t2", false), priced(NANO, "t3", false)],
]);
const sonnetArm = summarizeArm(sonnetSpec, [
  [priced(SONNET, "t1", true), priced(SONNET, "t2", true), priced(SONNET, "t3", true)],
  [priced(SONNET, "t1", true), priced(SONNET, "t2", true), priced(SONNET, "t3", false)],
]);

{
  assert.equal(nanoArm.runs, 2);
  assert.equal(nanoArm.tasksPerRun, 3);
  assert.equal(nanoArm.attempts, 6);
  assert.equal(nanoArm.passes, 3);
  close(nanoArm.passRate, 0.5, 1e-12, "nano pass rate:");
  assert.deepEqual(nanoArm.perRunPassed, [2, 1], "per-iteration spread must be preserved");
  close(nanoArm.stdevPassed, 0.5, 1e-12, "nano stdev:");
  assert.equal(nanoArm.meanTokensPerTask, 110_000);
  close(nanoArm.meanTurnsPerTask!, 4, 1e-12);

  // The interval is cross-checked against an independently written form of the
  // Wilson formula rather than a snapshot of our own output.
  close(nanoArm.ci.low, refWilson(3, 6)[0], 1e-12, "wilson low 3/6:");
  close(nanoArm.ci.high, refWilson(3, 6)[1], 1e-12, "wilson high 3/6:");
  close(sonnetArm.ci.low, refWilson(5, 6)[0], 1e-12, "wilson low 5/6:");
  close(sonnetArm.ci.high, refWilson(5, 6)[1], 1e-12, "wilson high 5/6:");
  close(nanoArm.ci.low, 0.1876128, 1e-6, "wilson low 3/6 pinned:");
  close(sonnetArm.ci.high, 0.9699474, 1e-6, "wilson high 5/6 pinned:");

  // The interval must bracket the observed rate and tighten as evidence grows.
  assert.ok(nanoArm.ci.low < nanoArm.passRate && nanoArm.passRate < nanoArm.ci.high);
  const wide = refWilson(3, 6);
  const tight = refWilson(30, 60);
  assert.ok(tight[1] - tight[0] < wide[1] - wide[0], "10x the samples must narrow the interval");

  // Cost: 6 attempts x $0.0084 = $0.0504.
  assert.ok(nanoArm.cost, "a fully priced arm must report cost");
  close(nanoArm.cost!.totalUsd, 0.0504, 1e-9, "nano total:");
  close(nanoArm.cost!.perTaskUsd, 0.0084, 1e-9, "nano per task:");
  close(nanoArm.cost!.passesPerUsd, 3 / 0.0504, 1e-6, "nano passes/$:");
  close(nanoArm.cost!.usdPerPass!, 0.0504 / 3, 1e-9, "nano $/pass:");

  close(sonnetArm.cost!.totalUsd, 2.7, 1e-9, "sonnet total:");
  close(sonnetArm.cost!.passesPerUsd, 5 / 2.7, 1e-6, "sonnet passes/$:");

  // The headline the submission leans on: far cheaper per passing task.
  assert.ok(
    nanoArm.cost!.passesPerUsd > sonnetArm.cost!.passesPerUsd * 30,
    "nano must be >30x more cost-efficient with these prices",
  );

  // Per-task breakdown, sorted hardest-first.
  const byId = new Map(nanoArm.tasks.map((t) => [t.taskId, t]));
  assert.equal(byId.get("t1")!.passes, 2);
  assert.equal(byId.get("t2")!.passes, 1);
  assert.equal(byId.get("t3")!.passes, 0);
  assert.equal(nanoArm.tasks[0]!.taskId, "t3", "tasks sort by ascending pass rate");
}

// --- 3. Cost is withheld unless every attempt was priced --------------------
{
  const partial = summarizeArm(nanoSpec, [
    [priced(NANO, "t1", true), mk("t2", true, TOKENS)], // second attempt has no costUsd
  ]);
  assert.equal(partial.cost, undefined, "a partially priced arm must not report cost");
  assert.match(partial.costNote!, /only 1\/2 attempts were priced/);

  const unpriced = summarizeArm(
    { id: "x", provider: "gpt", model: "mystery-model" },
    [[mk("t1", true), mk("t2", false)]],
  );
  assert.equal(unpriced.cost, undefined);
  assert.match(unpriced.costNote!, /no price entry for model "mystery-model"/);
  // Pass rate still works without pricing.
  close(unpriced.passRate, 0.5, 1e-12);
}

// --- 4. ACRR: over-reading against the oracle minimum -----------------------
{
  const arm = summarizeArm(nanoSpec, [
    [priced(NANO, "t1", true, { inspectedFiles: 4, oracleFiles: 1 })],
    [priced(NANO, "t1", true, { inspectedFiles: 2, oracleFiles: 1 })],
  ]);
  // (4 + 2 - 2) / 2 = 2.0 — the agent read 3x the minimum on average.
  close(arm.acrr!.value, 2, 1e-12, "acrr:");
  assert.equal(arm.acrr!.attempts, 2);
  close(arm.meanFilesPerTask!, 3, 1e-12);

  // Tasks without an oracle contribute no ACRR rather than a fake zero.
  assert.equal(summarizeArm(nanoSpec, [[priced(NANO, "t1", true)]]).acrr, undefined);
}

// --- 5. Significance: overlapping intervals must NOT name a winner ----------
const provenance: BenchmarkProvenance = {
  taskSet: "eval",
  taskIds: ["t1", "t2", "t3"],
  runsPerArm: 2,
  timeoutMs: 150_000,
  harness: { router: false, experienceAdvice: false, experienceRouting: false, approvalPolicy: "auto" },
  scissorVersion: "0.2.0",
  gitCommit: "abc1234",
  gitDirty: false,
  nodeVersion: "v24",
  platform: "linux",
  pricing: [
    { model: NANO, inputPer1M: 0.06, outputPer1M: 0.24 },
    { model: SONNET, inputPer1M: 3, outputPer1M: 15 },
  ],
  pricingSource: "public list prices",
};

const report = buildBenchmarkReport({
  provenance,
  arms: [nanoArm, sonnetArm],
  generatedAt: "2026-09-21T00:00:00.000Z",
});

{
  assert.equal(report.schemaVersion, BENCHMARK_SCHEMA_VERSION);
  assert.equal(report.arms[0]!.id, "sonnet", "arms sort by descending pass rate");
  assert.equal(report.arms[1]!.id, "nemotron-nano");

  // 3/6 vs 5/6 at N=2 is nowhere near separable.
  assert.equal(report.leader!.armId, "sonnet");
  assert.equal(report.leader!.significant, false, "overlapping CIs must not be called significant");
  assert.match(report.leader!.note, /NOT statistically significant/);
  assert.equal(report.pairwise[0]!.verdict, "inconclusive");
  assert.equal(report.pairwise[0]!.ciDisjoint, false);
  close(report.pairwise[0]!.deltaPp, (5 / 6 - 3 / 6) * 100, 1e-9);

  // Cost leader is decided independently of pass rate.
  assert.equal(report.costLeader!.armId, "nemotron-nano");
}

// A genuinely separated pair must be reported as significant.
{
  const strong = summarizeArm({ id: "strong", provider: "gpt", model: SONNET }, [
    Array.from({ length: 20 }, (_, i) => priced(SONNET, `t${i}`, true)),
  ]);
  const weak = summarizeArm({ id: "weak", provider: "gpt", model: SONNET }, [
    Array.from({ length: 20 }, (_, i) => priced(SONNET, `t${i}`, i < 2)),
  ]);
  const vs = compareArms(strong, weak);
  assert.equal(vs.ciDisjoint, true, "20/20 vs 2/20 must be separable");
  assert.equal(vs.verdict, "a-better");

  const r = buildBenchmarkReport({ provenance, arms: [strong, weak] });
  assert.equal(r.leader!.significant, true);
  assert.match(r.leader!.note, /disjoint/);
}

// A single arm has nothing to be significant against.
{
  const solo = buildBenchmarkReport({ provenance, arms: [nanoArm] });
  assert.equal(solo.leader!.significant, false);
  assert.match(solo.leader!.note, /Only one arm/);
  assert.deepEqual(solo.pairwise, []);
}

// --- 6. Markdown rendering --------------------------------------------------
const md = formatBenchmarkMarkdown(report);
{
  assert.match(md, /^# scissor provider benchmark/m);
  assert.match(md, /\*\*N = 2\*\*/, "N must be stated up front");
  assert.match(md, /task set \*\*eval\*\*/);

  // Method table: the harness settings held fixed.
  assert.match(md, /\| Model router \| off \(model held fixed\) \|/);
  assert.match(md, /\| Experience layer \| off \|/);
  assert.match(md, /\| Commit \| `abc1234` \|/);
  assert.match(md, /Node v24 on linux/);

  // Results table with the required columns.
  for (const col of ["Pass rate", "95% CI (Wilson)", "Tokens/task", "Cost/task", "Turns/task", "Files/task", "ACRR"]) {
    assert.ok(md.includes(col), `results table must carry a "${col}" column`);
  }
  assert.match(md, /\| 83\.3% \| 43\.6% – 97\.0% \|/, "sonnet row renders rate + CI");
  assert.match(md, /\| 50\.0% \| 18\.8% – 81\.2% \|/, "nano row renders rate + CI");
  assert.match(md, /110,000/, "tokens/task is rendered readably");

  // Variance is shown, not hidden behind a mean.
  assert.match(md, /Run-to-run spread/);
  assert.match(md, /\*\*nemotron-nano\*\* 2, 1/);

  // Cost section, including the per-dollar headline and the price table.
  assert.match(md, /## Cost efficiency/);
  assert.match(md, /Passes per \$1/);
  assert.match(md, /Best cost efficiency: \*\*nemotron-nano\*\*/);
  assert.match(md, /\$0\.0084/, "cost/task renders at sub-cent precision");
  assert.match(md, /\| `nvidia\/NVIDIA-Nemotron-3-Nano-30B-A3B` \| \$0\.06 \| \$0\.24 \|/);

  // The honesty sections.
  assert.match(md, /## Is the difference real\?/);
  assert.match(md, /NOT statistically significant/);
  assert.match(md, /\| sonnet vs nemotron-nano \| \+33\.3 pp \| no \| inconclusive \|/);
  assert.match(md, /## Limitations/);
  assert.ok(md.includes("independent Bernoulli trials"), "must disclose the iid assumption");
  assert.ok(md.includes("list prices"), "must disclose that costs are list-price estimates");

  // Per-task matrix lets a reader run their own paired test.
  assert.match(md, /## Per-task detail/);
  assert.match(md, /\| `t3` \| 1\/2 \| 0\/2 \|/);
}

// An unpriced arm renders a reason instead of a fabricated number.
{
  const unpriced = summarizeArm({ id: "u", provider: "gpt", model: "mystery" }, [[mk("t1", true)]]);
  const r = buildBenchmarkReport({ provenance, arms: [sonnetArm, unpriced] });
  const out = formatBenchmarkMarkdown(r);
  assert.match(out, /— \(no price entry for model "mystery"\)/);
}

// --- 7. Nothing machine-specific may reach the committed artifact -----------
{
  const serialized = JSON.stringify(report) + "\n" + md;

  // The synthetic results all carried a temp path in `detail`; aggregation must
  // have dropped it rather than copying it through.
  assert.ok(!serialized.includes("scissor-eval-a1b2c3"), "raw temp paths must not leak");
  assert.ok(!serialized.includes("AppData"), "raw detail strings must not leak");
  assert.ok(!/[A-Za-z]:\\/.test(serialized), "no Windows absolute paths");
  assert.ok(!serialized.includes("/home/"), "no POSIX home paths");
  assert.ok(!serialized.includes("/Users/"), "no macOS home paths");
  assert.ok(!serialized.includes(process.cwd()), "no working directory");

  const host = os.hostname();
  if (host && host.length > 3) assert.ok(!serialized.includes(host), "no hostname");
  let user = "";
  try {
    user = os.userInfo().username;
  } catch {
    /* unavailable in some sandboxes */
  }
  if (user && user.length > 3) assert.ok(!serialized.includes(user), "no username");

  // Real credential shapes, not any string containing "sk-" (which "task-runs"
  // would trip).
  assert.ok(!/\bsk-[A-Za-z0-9]{12,}/.test(serialized), "no OpenAI-shaped key");
  assert.ok(!/\btvly-[A-Za-z0-9]{12,}/.test(serialized), "no Tavily-shaped key");
  assert.ok(!/api[_-]?key["'\s]*[:=]/i.test(serialized), "no api key assignment");
}

// --- 8. Arm specs and task sets ---------------------------------------------
{
  const defaultModelFor = (p: string) => (p === "nebius" ? NANO : "some-default");

  const bare = parseArm("nebius", defaultModelFor);
  assert.deepEqual(bare, { id: "nebius", provider: "nebius", model: NANO });

  const pinned = parseArm(`ultra=nebius:${ULTRA}`, defaultModelFor);
  assert.deepEqual(pinned, { id: "ultra", provider: "nebius", model: ULTRA });

  // Without a label, the id is derived from the model's last path segment so
  // three Nemotron tiers on one provider stay distinguishable.
  const derived = parseArm(`nebius:${SUPER}`, defaultModelFor);
  assert.equal(derived.id, "nebius:nemotron-3-super-120b-a12b");
  assert.equal(derived.model, SUPER);

  assert.throws(() => parseArm("notaprovider", defaultModelFor), /Unknown provider/);
  assert.throws(() => parseArm("", defaultModelFor), /missing provider/);

  assert.equal(resolveTaskSet({ tasks: "eval" }).tasks.length, 6);
  assert.equal(resolveTaskSet({ tasks: "bench" }).tasks.length, 11);
  assert.equal(resolveTaskSet({ tasks: "all" }).tasks.length, 17);
  assert.equal(resolveTaskSet({}).name, "eval", "defaults to the cheap hermetic set");
  assert.deepEqual(
    resolveTaskSet({ task: "create-file,edit-json" }).tasks.map((t) => t.id),
    ["create-file", "edit-json"],
  );
  assert.throws(() => resolveTaskSet({ tasks: "nope" }), /Unknown --tasks/);
}

process.stdout.write("test-benchmark: ALL PASS\n");
