/**
 * Deterministic test: the small shared utilities extracted during de-duping.
 * - safeParseJsonObject: shared by the Anthropic and OpenAI-compatible providers
 *   for parsing loose tool-call argument JSON.
 * - tail: shared by the verification loop and the self-update gate for trimming
 *   error output.
 *
 * Run: node --import tsx scripts/test-provider-util.mts
 */
import assert from "node:assert/strict";
import { safeParseJsonObject } from "@scissor/core";
import { tail } from "../packages/cli/src/text.js";

// safeParseJsonObject
{
  assert.deepEqual(safeParseJsonObject('{"a":1,"b":"x"}'), { a: 1, b: "x" });
  assert.deepEqual(safeParseJsonObject(""), {}, "empty string -> {}");
  assert.deepEqual(safeParseJsonObject("   "), {}, "whitespace -> {}");
  assert.deepEqual(safeParseJsonObject("{not json"), {}, "invalid JSON -> {}");
  assert.deepEqual(safeParseJsonObject("[1,2,3]"), {}, "array -> {} (must be an object)");
  assert.deepEqual(safeParseJsonObject("42"), {}, "number -> {}");
  assert.deepEqual(safeParseJsonObject("null"), {}, "null -> {}");
}

// tail
{
  assert.equal(tail("short", 100), "short", "short strings pass through unchanged");
  const long = "x".repeat(50);
  const t = tail(long, 10);
  assert.ok(t.startsWith("... "), "truncated output is prefixed with an ellipsis");
  assert.equal(t, "... " + "x".repeat(10), "keeps the last n characters");
}

process.stdout.write("test-provider-util: ALL PASS\n");
