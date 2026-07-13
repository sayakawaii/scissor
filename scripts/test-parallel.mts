/**
 * Deterministic test: parallel read-only tool execution.
 * Covers: independent read-only (non-mutating) tool calls in one turn run
 * concurrently (their execution windows overlap and wall time is well under the
 * serial sum), mutating tool calls run sequentially (windows do NOT overlap),
 * and tool results are always pushed back in the original call order. No network.
 *
 * Run: node --import tsx scripts/test-parallel.mts
 */
import assert from "node:assert/strict";
import os from "node:os";
import {
  Agent,
  type ChatParams,
  type ChatResult,
  type LLMProvider,
  type Tool,
} from "@scissor/core";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Interval {
  name: string;
  start: number;
  end: number;
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** A tool that records its execution window and sleeps `delay` ms. */
function timedTool(name: string, delay: number, log: Interval[], mutating: boolean): Tool {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    mutating,
    async run() {
      const start = Date.now();
      await sleep(delay);
      const end = Date.now();
      log.push({ name, start, end });
      return { content: `${name} done` };
    },
  };
}

class ScriptProvider implements LLMProvider {
  id = "deepseek" as const;
  model = "script";
  queue: ChatResult[] = [];
  async chat(_p: ChatParams): Promise<ChatResult> {
    return this.queue.shift() ?? { text: "done", toolCalls: [] };
  }
}

// 1. Two read-only tools in one turn run concurrently (overlapping windows).
{
  const log: Interval[] = [];
  const tools = [
    timedTool("read_a", 60, log, false),
    timedTool("read_b", 60, log, false),
  ];
  const provider = new ScriptProvider();
  provider.queue = [
    {
      text: "",
      toolCalls: [
        { id: "a", name: "read_a", arguments: {} },
        { id: "b", name: "read_b", arguments: {} },
      ],
    },
    { text: "done", toolCalls: [] },
  ];
  const agent = new Agent({
    provider,
    tools,
    workspaceRoot: os.tmpdir(),
    approvalPolicy: "auto",
    systemPrompt: "s",
  });
  const t0 = Date.now();
  await agent.run("read both");
  const elapsed = Date.now() - t0;

  assert.equal(log.length, 2, "both read tools ran");
  const [a, b] = log[0]!.name === "read_a" ? [log[0]!, log[1]!] : [log[1]!, log[0]!];
  assert.ok(overlaps(a, b), "read-only tools executed concurrently (windows overlap)");
  // Serial would be ~120ms; concurrent should be well under.
  assert.ok(elapsed < 110, `concurrent read-only turn should be fast, got ${elapsed}ms`);
}

// 2. Mutating tools run sequentially (windows do NOT overlap).
{
  const log: Interval[] = [];
  const tools = [
    timedTool("write_a", 40, log, true),
    timedTool("write_b", 40, log, true),
  ];
  const provider = new ScriptProvider();
  provider.queue = [
    {
      text: "",
      toolCalls: [
        { id: "a", name: "write_a", arguments: {} },
        { id: "b", name: "write_b", arguments: {} },
      ],
    },
    { text: "done", toolCalls: [] },
  ];
  const agent = new Agent({
    provider,
    tools,
    workspaceRoot: os.tmpdir(),
    approvalPolicy: "auto",
    systemPrompt: "s",
  });
  await agent.run("write both");
  assert.equal(log.length, 2, "both mutating tools ran");
  assert.ok(!overlaps(log[0]!, log[1]!), "mutating tools ran sequentially (no overlap)");
}

// 3. Mixed turn: results are pushed in the ORIGINAL call order.
{
  const log: Interval[] = [];
  const tools = [
    timedTool("read_a", 30, log, false),
    timedTool("write_m", 20, log, true),
    timedTool("read_b", 30, log, false),
  ];
  const provider = new ScriptProvider();
  provider.queue = [
    {
      text: "",
      toolCalls: [
        { id: "a", name: "read_a", arguments: {} },
        { id: "m", name: "write_m", arguments: {} },
        { id: "b", name: "read_b", arguments: {} },
      ],
    },
    { text: "done", toolCalls: [] },
  ];
  const agent = new Agent({
    provider,
    tools,
    workspaceRoot: os.tmpdir(),
    approvalPolicy: "auto",
    systemPrompt: "s",
  });
  await agent.run("mixed");

  const toolMsgs = agent.getTranscript().filter((m) => m.role === "tool");
  assert.deepEqual(
    toolMsgs.map((m) => m.toolCallId),
    ["a", "m", "b"],
    "tool results pushed in original call order",
  );
  assert.deepEqual(
    toolMsgs.map((m) => m.name),
    ["read_a", "write_m", "read_b"],
  );
}

process.stdout.write("test-parallel: ALL PASS\n");
