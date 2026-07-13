/**
 * Deterministic test: the trace -> eval flywheel generator.
 * Covers: extracting the user prompt and the created/edited files from a trace,
 * de-duplicating paths, ignoring failed/non-edit tool events, embedding the
 * prompt safely (even with backticks/${} ), and producing valid task source. No
 * network.
 *
 * Run: node --import tsx scripts/test-eval-gen.mts
 */
import assert from "node:assert/strict";
import { generateEvalDraft } from "../packages/cli/src/eval-gen.js";
import type { TraceEvent } from "../packages/cli/src/trace.js";

const ev = (type: string, data: Record<string, unknown> = {}): TraceEvent => ({
  ts: "2026-01-01T00:00:00.000Z",
  type,
  ...data,
});

// 1. Basic extraction: prompt + edited files, de-duped and filtered.
{
  const events: TraceEvent[] = [
    ev("session-start", { sessionId: "abc123", model: "deepseek-chat" }),
    ev("user", { prompt: "Build a JSON<->CSV converter CLI with tests" }),
    ev("tool", { name: "write_file", ok: true, path: "src/convert.js" }),
    ev("tool", { name: "read_file", ok: true, path: "src/convert.js" }), // read: ignored
    ev("tool", { name: "edit_file", ok: true, path: "src/convert.js" }), // dup: ignored
    ev("tool", { name: "write_file", ok: true, path: "test/convert.test.js" }),
    ev("tool", { name: "write_file", ok: false, path: "src/broken.js" }), // failed: ignored
    ev("session-end", {}),
  ];
  const draft = generateEvalDraft(events);
  assert.equal(draft.id, "gen-abc123");
  assert.equal(draft.filename, "gen-abc123.eval.ts");
  assert.equal(draft.prompt, "Build a JSON<->CSV converter CLI with tests");
  assert.deepEqual(draft.files, ["src/convert.js", "test/convert.test.js"], "deduped, edits only, successes only");

  // Generated code embeds the prompt and both files, and references EvalTask shape.
  assert.match(draft.code, /GENERATED_TASKS/);
  assert.match(draft.code, /Build a JSON<->CSV converter CLI with tests/);
  assert.match(draft.code, /src\/convert\.js/);
  assert.match(draft.code, /test\/convert\.test\.js/);
  assert.match(draft.code, /async check\(dir: string\)/);
}

// 2. Prompt with backticks / ${} is embedded safely (JSON.stringify, not template).
{
  const events: TraceEvent[] = [
    ev("session-start", { sessionId: "x" }),
    ev("user", { prompt: "use `npm test` and ${HOME} and \"quotes\"" }),
    ev("session-end", {}),
  ];
  const draft = generateEvalDraft(events);
  // The prompt is embedded as a JSON string literal, so the dangerous sequences
  // are escaped/quoted rather than interpolated.
  assert.match(draft.code, /prompt: "use `npm test` and \$\{HOME\} and \\"quotes\\""/);
  assert.deepEqual(draft.files, []);
}

// 3. id override.
{
  const events: TraceEvent[] = [ev("user", { prompt: "hi" })];
  const draft = generateEvalDraft(events, { id: "my-case" });
  assert.equal(draft.id, "my-case");
  assert.match(draft.code, /id: "my-case"/);
}

// 4. No prompt -> empty prompt string (command layer warns on this).
{
  const draft = generateEvalDraft([ev("session-start", { sessionId: "z" })]);
  assert.equal(draft.prompt, "");
}

process.stdout.write("test-eval-gen: ALL PASS\n");
