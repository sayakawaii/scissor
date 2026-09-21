/**
 * Deterministic test: per-tool execution limits, output spilling, and lenient
 * argument coercion.
 *
 * Covers: suggestedToolTimeoutMs tiering (default / sub-agent / block_until_ms
 * escalation), a hung tool being abandoned with an actionable message and its
 * abort signal fired, oversized tool results spilled to .scissor/tool-output
 * with the full text preserved and a do-not-retry notice, spilling being
 * idempotent, and the coerce helpers repairing the shapes models actually send.
 * No network.
 *
 * Run: node --import tsx scripts/test-tool-limits.mts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Agent,
  coerceArray,
  coerceBoolean,
  coerceEnum,
  coerceNumber,
  coerceStringArray,
  createOutputSpillGuard,
  DEFAULT_TOOL_TIMEOUT_MS,
  editFileTool,
  readFileTool,
  retrieveTool,
  suggestedToolTimeoutMs,
  SUBAGENT_TOOL_TIMEOUT_MS,
  TIMEOUT_TIERS,
  TOOL_OUTPUT_DIRNAME,
  type ChatParams,
  type ChatResult,
  type LLMProvider,
  type Tool,
} from "@scissor/core";

class ScriptProvider implements LLMProvider {
  id = "deepseek" as const;
  model = "script";
  queue: ChatResult[] = [];
  async chat(_p: ChatParams): Promise<ChatResult> {
    return this.queue.shift() ?? { text: "done", toolCalls: [] };
  }
}

// ---------------------------------------------------------------- tier choice

assert.equal(
  suggestedToolTimeoutMs("read_file", { path: "a.ts" }),
  DEFAULT_TOOL_TIMEOUT_MS,
  "an ordinary tool gets the default tier",
);
assert.equal(
  suggestedToolTimeoutMs("spawn_subagent", { task: "x" }),
  SUBAGENT_TOOL_TIMEOUT_MS,
  "a sub-agent gets the top tier",
);
assert.equal(
  suggestedToolTimeoutMs("run_shell", { command: "x", block_until_ms: 1000 }),
  DEFAULT_TOOL_TIMEOUT_MS,
  "a small block_until_ms stays in the default tier",
);
{
  // A block window past the first tier escalates to the next one that covers it.
  const ms = suggestedToolTimeoutMs("run_shell", { command: "x", block_until_ms: 10 * 60_000 });
  assert.equal(ms, TIMEOUT_TIERS[1], "block_until_ms beyond the first tier escalates");
  assert.ok(ms > 10 * 60_000, "the ceiling exceeds the requested window");
}
{
  // Beyond the top tier the explicit request wins over the tier ladder.
  const requested = 3 * 60 * 60_000;
  const ms = suggestedToolTimeoutMs("run_shell", { command: "x", block_until_ms: requested });
  assert.ok(ms > requested, "an over-tier request is honored with grace on top");
}
assert.equal(
  suggestedToolTimeoutMs("run_shell", { command: "x", block_until_ms: "600000" }),
  TIMEOUT_TIERS[1],
  "a stringified block_until_ms is coerced before tiering",
);

// -------------------------------------------------------- hung tool abandoned

{
  let sawAbort = false;
  const hangTool: Tool = {
    name: "run_shell",
    description: "blocks forever, ignoring abort",
    parameters: { type: "object", properties: {} },
    async run(_args, ctx) {
      ctx.signal?.addEventListener("abort", () => {
        sawAbort = true;
      }, { once: true });
      await new Promise<void>(() => {
        /* never resolves: the agent must abandon this call on its own */
      });
      return { content: "unreachable" };
    },
  };

  const agent = new Agent({
    provider: new ScriptProvider(),
    tools: [hangTool],
    workspaceRoot: os.tmpdir(),
    approvalPolicy: "auto",
    systemPrompt: "BASE",
    toolTimeoutMs: 150,
  });
  const started = Date.now();
  const result = await agent.runTool("run_shell", { command: "sleep forever" });
  const elapsed = Date.now() - started;
  assert.equal(result.isError, true, "a hung call is reported as an error");
  assert.match(result.content, /exceeded its .* execution limit/, "the limit is named");
  assert.match(result.content, /block_until_ms: 0/, "the message says what to do instead");
  assert.match(result.content, /await_shell/, "it points at the polling tool");
  assert.ok(elapsed < 3000, `the agent gave up promptly (${elapsed}ms)`);
  assert.ok(sawAbort, "the abandoned call's abort signal fired so it can clean up");
}

// A tool that finishes inside its ceiling is unaffected.
{
  const quick: Tool = {
    name: "quick",
    description: "returns immediately",
    parameters: { type: "object", properties: {} },
    async run() {
      return { content: "fast enough" };
    },
  };
  const agent = new Agent({
    provider: new ScriptProvider(),
    tools: [quick],
    workspaceRoot: os.tmpdir(),
    approvalPolicy: "auto",
    systemPrompt: "BASE",
    toolTimeoutMs: 5000,
  });
  const r = await agent.runTool("quick", {});
  assert.equal(r.content, "fast enough");
  assert.notEqual(r.isError, true);
}

// -------------------------------------------------------------- output spill

{
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-spill-"));
  const guard = createOutputSpillGuard({ workspaceRoot, maxChars: 1000 });
  const big = "L".repeat(400) + "M".repeat(4000) + "R".repeat(400);

  // Under the limit: untouched.
  const small = await guard.afterTool!({ id: "c0", name: "read_file", arguments: {} }, {
    content: "tiny",
  });
  assert.equal(small, undefined, "a small result is passed through unchanged");

  const spilled = await guard.afterTool!(
    { id: "c1", name: "read_file", arguments: {} },
    { content: big },
  );
  assert.ok(spilled, "an oversized result is transformed");
  assert.ok(spilled!.content.length < big.length, "the inline text shrank");
  assert.match(spilled!.content, /^L{100,}/, "the head is kept");
  assert.match(spilled!.content, /R{100,}/, "the tail is kept");
  assert.match(spilled!.content, /middle of the output omitted/, "the cut is marked");
  assert.match(spilled!.content, /Output truncated: \d+ chars/, "the notice states the real size");
  assert.match(spilled!.content, /will not return more inline/, "retrying is discouraged");
  assert.match(spilled!.content, /\.scissor\/tool-output\/c1\.txt/, "the file path is given");

  const saved = await fs.readFile(path.join(workspaceRoot, TOOL_OUTPUT_DIRNAME, "c1.txt"), "utf8");
  assert.equal(saved, big, "the full output is preserved on disk");

  // Idempotent: re-running the guard must not overwrite the saved file with the
  // excerpt (the excerpt plus notice can itself land over the budget).
  const again = await guard.afterTool!(
    { id: "c1", name: "read_file", arguments: {} },
    spilled!,
  );
  assert.equal(again, undefined, "an already-spilled result is left alone");
  const stillFull = await fs.readFile(
    path.join(workspaceRoot, TOOL_OUTPUT_DIRNAME, "c1.txt"),
    "utf8",
  );
  assert.equal(stillFull, big, "the saved file was not clobbered");

  // isError survives the transform.
  const failed = await guard.afterTool!(
    { id: "c2", name: "run_shell", arguments: {} },
    { content: big, isError: true },
  );
  assert.equal(failed!.isError, true, "error status is preserved");

  // A tool id with path separators cannot escape the output directory.
  const nasty = await guard.afterTool!(
    { id: "../../escape", name: "read_file", arguments: {} },
    { content: big },
  );
  const nastyPath = /FULL output is in (\S+)/.exec(nasty!.content)![1]!;
  assert.equal(
    nastyPath,
    ".scissor/tool-output/______escape.txt",
    "separators and dots are collapsed, so the file stays in the output directory",
  );

  await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
}

// The guard is on by default, so a plain Agent spills without extra wiring.
{
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-spill-agent-"));
  const chatty: Tool = {
    name: "chatty",
    description: "returns a lot",
    parameters: { type: "object", properties: {} },
    async run() {
      return { content: "x".repeat(200_000) };
    },
  };
  const agent = new Agent({
    provider: new ScriptProvider(),
    tools: [chatty],
    workspaceRoot,
    approvalPolicy: "auto",
    systemPrompt: "BASE",
  });
  const r = await agent.runTool("chatty", {});
  assert.ok(r.content.length < 200_000, "the built-in guard bounded the result");
  assert.match(r.content, /Output truncated/, "the built-in guard fired");
  await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
}

// ------------------------------------------------------------------- coercion

// Arrays: real arrays pass through, stringified arrays are repaired.
assert.deepEqual(coerceArray(["a", "b"]), ["a", "b"]);
assert.deepEqual(coerceArray('["a","b"]'), ["a", "b"]);
assert.deepEqual(coerceArray('[{"id":"x"}]'), [{ id: "x" }]);
assert.equal(coerceArray(42), undefined, "a number is not a list");
assert.equal(coerceArray(""), undefined, "an empty string is not a list");

// A lone scalar becomes a one-element array only when items are primitives...
assert.deepEqual(coerceArray("just one", { primitiveItems: true }), ["just one"]);
assert.equal(coerceArray("just one"), undefined, "no wrapping for object items");
// ...and never when it looks like it actually holds several items.
assert.equal(
  coerceArray("first, second", { primitiveItems: true }),
  undefined,
  "an ambiguous comma-separated scalar is refused rather than guessed at",
);
assert.equal(
  coerceArray("first\nsecond", { primitiveItems: true }),
  undefined,
  "an ambiguous newline-separated scalar is refused",
);

// Leaked parameter markup around the value.
assert.deepEqual(
  coerceArray('<parameter name="queries">["a","b"]</parameter>', { field: "queries" }),
  ["a", "b"],
  "markup naming this field is unwrapped",
);
assert.equal(
  coerceArray('<parameter name="other">["a"]</parameter>', { field: "queries" }),
  undefined,
  "markup naming a different field is refused",
);

// A valid array followed by structural junk.
assert.deepEqual(coerceArray('["a","b"]]'), ["a", "b"], "a trailing bracket is dropped");
// Brackets inside strings must not confuse the balance scan.
assert.deepEqual(coerceArray('["a]b","c"]'), ["a]b", "c"], "brackets inside strings are ignored");

assert.deepEqual(coerceStringArray('["  a  ","","b"]'), ["a", "b"], "trims and drops empties");

// Numbers, booleans, enums.
assert.equal(coerceNumber(3), 3);
assert.equal(coerceNumber("3"), 3);
assert.equal(coerceNumber(" 2500 "), 2500);
assert.equal(coerceNumber("abc"), undefined);
assert.equal(coerceNumber(Number.NaN), undefined);
assert.equal(coerceBoolean(true), true);
assert.equal(coerceBoolean("true"), true);
assert.equal(coerceBoolean("FALSE"), false);
assert.equal(coerceBoolean("0"), false);
assert.equal(coerceBoolean("maybe"), undefined);
assert.equal(coerceEnum("IN_PROGRESS", ["pending", "in_progress"] as const), "in_progress");
assert.equal(coerceEnum(" pending ", ["pending", "in_progress"] as const), "pending");
assert.equal(coerceEnum("nope", ["pending"] as const), undefined);

// The tools that actually take arrays accept the stringified form end to end.
{
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-coerce-"));
  await fs.writeFile(path.join(workspaceRoot, "a.txt"), "alpha\nbeta\ngamma\n", "utf8");

  const applied = await editFileTool.run(
    {
      path: "a.txt",
      edits: JSON.stringify([
        { old_string: "alpha", new_string: "ALPHA" },
        { old_string: "gamma", new_string: "GAMMA", replace_all: "true" },
      ]),
    },
    { workspaceRoot },
  );
  assert.notEqual(applied.isError, true, `stringified edits applied: ${applied.content}`);
  const after = await fs.readFile(path.join(workspaceRoot, "a.txt"), "utf8");
  assert.equal(after, "ALPHA\nbeta\nGAMMA\n", "both edits landed");

  // A shape we cannot read is a clear argument error, not a silent no-op.
  const bad = await editFileTool.run({ path: "a.txt", edits: "beta" }, { workspaceRoot });
  assert.equal(bad.isError, true, "an unreadable edits value is rejected");
  assert.match(bad.content, /must be an array/);

  // read_file's line bounds accept numeric strings.
  const read = await readFileTool.run(
    { path: "a.txt", start_line: "2", end_line: "2" },
    { workspaceRoot },
  );
  assert.match(read.content, /lines 2-2 of/, "stringified line bounds coerced");
  assert.match(read.content, /beta/);

  // retrieve reports a bad `queries` shape instead of silently searching nothing.
  const retrieved = await retrieveTool.run({ queries: 42 }, { workspaceRoot });
  assert.equal(retrieved.isError, true);
  assert.match(retrieved.content, /'queries' must be an array of strings/);

  await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
}

process.stdout.write("test-tool-limits: ALL PASS\n");
