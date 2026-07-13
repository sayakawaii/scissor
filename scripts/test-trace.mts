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
import { createTracer } from "../packages/cli/src/trace.js";

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

await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

process.stdout.write("test-trace: ALL PASS\n");
