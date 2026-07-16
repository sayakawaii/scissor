/**
 * Deterministic test: the structured JSONL tracer.
 * Covers: events are appended as one JSON object per line with a timestamp and
 * type, payloads are preserved, tool durations are measured, and close() writes
 * a terminal session-end and stops further writes. No network.
 *
 * Run: node --import tsx scripts/test-trace.mts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTracer, pruneTraces } from "../packages/cli/src/trace.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-trace-"));
const file = path.join(dir, "sub", "session.jsonl"); // nested dir must be created

const tracer = createTracer(file);
tracer.record("session-start", { sessionId: "abc", provider: "deepseek", model: "deepseek-chat" });
tracer.record("turn", { turn: 1 });
tracer.record("route", { tier: "strong", reasons: ["complex-intent"], score: 3 });

tracer.toolStart("t1");
// Busy-wait a couple ms so the measured duration is >= 0 and defined.
const spin = Date.now();
while (Date.now() - spin < 3) {
  /* wait */
}
const ms = tracer.toolMs("t1");
assert.ok(typeof ms === "number" && ms >= 0, "toolMs returns a duration");
assert.equal(tracer.toolMs("missing"), undefined, "unknown tool id -> undefined");

tracer.record("tool", { name: "read_file", ok: true, ms });
tracer.record("usage", { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
tracer.close();

// Writes after close are ignored (except the single session-end from close()).
tracer.record("turn", { turn: 2 });

const raw = await fs.readFile(file, "utf8");
const lines = raw.trim().split("\n");
const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);

// Every line parses and has ts + type.
for (const e of events) {
  assert.ok(typeof e.ts === "string" && e.ts.length > 0, "event has ts");
  assert.ok(typeof e.type === "string", "event has type");
}

const types = events.map((e) => e.type);
assert.deepEqual(
  types,
  ["session-start", "turn", "route", "tool", "usage", "session-end"],
  "events recorded in order; post-close write ignored",
);

const start = events[0]!;
assert.equal(start.sessionId, "abc");
assert.equal(start.provider, "deepseek");

const route = events.find((e) => e.type === "route")!;
assert.deepEqual(route.reasons, ["complex-intent"]);
assert.equal(route.score, 3);

const usage = events.find((e) => e.type === "usage")!;
assert.equal(usage.totalTokens, 15);

// --- pruneTraces keeps the N most-recent traces ---
{
  const pdir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-prune-"));
  // Create 5 trace files with strictly increasing mtimes (old -> new).
  const names = ["a", "b", "c", "d", "e"];
  const base = Date.now() - 10_000;
  for (let i = 0; i < names.length; i++) {
    const p = path.join(pdir, `${names[i]}.jsonl`);
    await fs.writeFile(p, "{}\n", "utf8");
    const t = new Date(base + i * 1000);
    await fs.utimes(p, t, t);
  }
  // A non-trace file must be left untouched.
  await fs.writeFile(path.join(pdir, "keep.txt"), "x", "utf8");

  pruneTraces(pdir, 2);
  const left = (await fs.readdir(pdir)).sort();
  assert.deepEqual(left, ["d.jsonl", "e.jsonl", "keep.txt"], "keeps 2 newest traces + non-trace file");

  // keep >= count is a no-op; keep 0 removes all traces.
  pruneTraces(pdir, 10);
  assert.equal((await fs.readdir(pdir)).filter((f) => f.endsWith(".jsonl")).length, 2, "no-op when keep >= count");
  pruneTraces(pdir, 0);
  assert.equal((await fs.readdir(pdir)).filter((f) => f.endsWith(".jsonl")).length, 0, "keep 0 clears traces");

  // Missing directory: best-effort, no throw.
  pruneTraces(path.join(pdir, "does-not-exist"), 5);

  await fs.rm(pdir, { recursive: true, force: true }).catch(() => {});
}

await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

process.stdout.write("test-trace: ALL PASS\n");
