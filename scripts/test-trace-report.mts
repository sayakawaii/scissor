/**
 * Deterministic test: trace aggregation into a token/cost report.
 * Covers: token totals, per-model attribution via route events (router on),
 * approximate cost estimation (and partial-cost flag for unpriced models), tool
 * call/error/duration stats, routing counts, verify/compact/subagent counts,
 * duration, and JSONL parsing (skipping malformed lines). No network.
 *
 * Run: node --import tsx scripts/test-trace-report.mts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  aggregateTrace,
  priceFor,
  readTraceFile,
  latestTraceFile,
  MODEL_PRICES,
} from "../packages/cli/src/trace-report.js";
import type { TraceEvent } from "../packages/cli/src/trace.js";

const ev = (type: string, data: Record<string, unknown> = {}, ts = "2026-01-01T00:00:00.000Z"): TraceEvent => ({
  ts,
  type,
  ...data,
});

// 1. Basic single-model aggregation + cost.
{
  const events: TraceEvent[] = [
    ev("session-start", { sessionId: "s1", provider: "deepseek", model: "deepseek-chat" }, "2026-01-01T00:00:00.000Z"),
    ev("turn", { turn: 1 }),
    ev("usage", { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 }),
    ev("tool", { name: "read_file", ok: true, ms: 12 }),
    ev("tool", { name: "read_file", ok: true, ms: 8 }),
    ev("tool", { name: "run_shell", ok: false, ms: 50 }),
    ev("verify", { ok: false, skipped: false }),
    ev("compact", { summarizedMessages: 4 }),
    ev("subagent", { phase: "start", depth: 1 }),
    ev("subagent", { phase: "end", depth: 1 }),
    ev("session-end", {}, "2026-01-01T00:00:05.000Z"),
  ];
  const r = aggregateTrace(events);
  assert.equal(r.sessionId, "s1");
  assert.equal(r.turns, 1);
  assert.equal(r.promptTokens, 1_000_000);
  assert.equal(r.completionTokens, 1_000_000);
  assert.equal(r.totalTokens, 2_000_000);
  assert.equal(r.durationMs, 5000);

  // 1M input @ 0.27 + 1M output @ 1.10 = 1.37
  const price = MODEL_PRICES["deepseek-chat"]!;
  const expected = price.inputPer1M + price.outputPer1M;
  assert.ok(Math.abs(r.costUsd - expected) < 1e-9, `cost ${r.costUsd} ~= ${expected}`);
  assert.equal(r.costPartial, false);
  assert.equal(r.perModel.length, 1);
  assert.equal(r.perModel[0]!.model, "deepseek-chat");

  // Tool stats: read_file 2x (0 err, 20ms), run_shell 1x (1 err, 50ms).
  const rf = r.tools.find((t) => t.name === "read_file")!;
  assert.equal(rf.calls, 2);
  assert.equal(rf.errors, 0);
  assert.equal(rf.totalMs, 20);
  assert.equal(r.toolCalls, 3);
  assert.equal(r.toolErrors, 1);

  assert.equal(r.verifyRuns, 1);
  assert.equal(r.verifyFailures, 1);
  assert.equal(r.compactions, 1);
  assert.equal(r.subagents, 1);
}

// 2. Router on: usage attributed to the last-routed model; per-model + routes.
{
  const events: TraceEvent[] = [
    ev("session-start", { sessionId: "s2", provider: "deepseek", model: "deepseek-chat" }),
    ev("turn", { turn: 1 }),
    ev("route", { tier: "cheap", model: "deepseek-chat" }),
    ev("usage", { promptTokens: 100, completionTokens: 50 }),
    ev("turn", { turn: 2 }),
    ev("route", { tier: "strong", model: "deepseek-reasoner" }),
    ev("usage", { promptTokens: 200, completionTokens: 100 }),
    ev("session-end", {}),
  ];
  const r = aggregateTrace(events);
  assert.equal(r.routes.cheap, 1);
  assert.equal(r.routes.strong, 1);
  assert.equal(r.perModel.length, 2);
  const chat = r.perModel.find((m) => m.model === "deepseek-chat")!;
  const reasoner = r.perModel.find((m) => m.model === "deepseek-reasoner")!;
  assert.equal(chat.totalTokens, 150, "totalTokens derived from prompt+completion when absent");
  assert.equal(reasoner.totalTokens, 300);
  assert.ok(chat.costUsd! > 0 && reasoner.costUsd! > 0);
}

// 3. Unpriced model -> costPartial true, tokens still counted.
{
  const events: TraceEvent[] = [
    ev("session-start", { sessionId: "s3", provider: "custom", model: "mystery-model" }),
    ev("usage", { promptTokens: 10, completionTokens: 5, totalTokens: 15 }),
    ev("session-end", {}),
  ];
  const r = aggregateTrace(events);
  assert.equal(r.totalTokens, 15);
  assert.equal(r.costPartial, true, "unpriced model flags partial cost");
  assert.equal(r.costUsd, 0);
  assert.equal(priceFor("mystery-model"), undefined);
  assert.ok(priceFor("deepseek-chat"));
}

// 4. readTraceFile skips blank/malformed lines; latestTraceFile picks newest.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-tracerep-"));
  const f1 = path.join(dir, "a.jsonl");
  await fs.writeFile(
    f1,
    [
      JSON.stringify(ev("session-start", { sessionId: "a", model: "deepseek-chat" })),
      "",
      "{ not json",
      JSON.stringify(ev("usage", { promptTokens: 5, completionTokens: 5, totalTokens: 10 })),
      JSON.stringify(ev("session-end", {})),
    ].join("\n"),
  );
  const parsed = await readTraceFile(f1);
  assert.equal(parsed.length, 3, "malformed and blank lines skipped");
  const r = aggregateTrace(parsed);
  assert.equal(r.totalTokens, 10);

  // Newer file wins.
  await new Promise((res) => setTimeout(res, 10));
  const f2 = path.join(dir, "b.jsonl");
  await fs.writeFile(f2, JSON.stringify(ev("session-start", { sessionId: "b" })) + "\n");
  const latest = await latestTraceFile(dir);
  assert.equal(latest, f2, "latestTraceFile returns most recently modified");

  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

process.stdout.write("test-trace-report: ALL PASS\n");
