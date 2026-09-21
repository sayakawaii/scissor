/**
 * Deterministic test: max-min fair-share context reduction.
 *
 * The property that matters: when one old message is huge, that message is
 * shrunk — the surrounding round (the user's request, the other tool results)
 * survives, which is exactly what the previous drop-oldest-round fallback got
 * wrong. Also covers the allocator's arithmetic, the omitted/shortened notice,
 * protection of the system prompt and the current round, and tool-call pairing
 * staying intact. No network.
 *
 * Run: node --import tsx scripts/test-fair-truncate.mts
 */
import assert from "node:assert/strict";
import os from "node:os";
import {
  Agent,
  computeMaxMinFairAllocations,
  elideMiddle,
  MIN_USEFUL_CHARS,
  truncateMessagesFairly,
  type ChatParams,
  type ChatResult,
  type LLMProvider,
  type Message,
} from "@scissor/core";

class ScriptProvider implements LLMProvider {
  id = "deepseek" as const;
  model = "script";
  /** The messages handed to the provider on the most recent call. */
  lastMessages: Message[] = [];
  queue: ChatResult[] = [];
  async chat(p: ChatParams): Promise<ChatResult> {
    this.lastMessages = [...p.messages];
    return this.queue.shift() ?? { text: "done", toolCalls: [] };
  }
}

// ------------------------------------------------------------- the allocator

{
  // Everything fits: nobody is cut.
  assert.deepEqual(computeMaxMinFairAllocations([10, 20, 30], 100), [10, 20, 30]);

  // Equal demands split the budget evenly.
  assert.deepEqual(computeMaxMinFairAllocations([100, 100], 100), [50, 50]);

  // The key property: slack left by small items rolls forward to the big one.
  // A naive equal split would give each 100; instead the two small messages
  // take what they need and the large one absorbs the rest.
  const alloc = computeMaxMinFairAllocations([10, 10, 1000], 300);
  assert.deepEqual(alloc, [10, 10, 280], "slack is redistributed to the large item");
  assert.equal(
    alloc.reduce((a, b) => a + b, 0),
    300,
    "the whole budget is used",
  );

  // Never over budget, never negative.
  for (const budget of [0, 1, 7, 999]) {
    const a = computeMaxMinFairAllocations([5, 50, 500, 5000], budget);
    assert.ok(a.every((x) => x >= 0), "no negative allocation");
    assert.ok(a.reduce((x, y) => x + y, 0) <= budget, `within budget (${budget})`);
  }
  assert.deepEqual(computeMaxMinFairAllocations([], 100), [], "empty input");
}

// ------------------------------------------------------------ elideMiddle

{
  assert.equal(elideMiddle("short", 100), "short", "text under budget is untouched");
  const long = "H".repeat(500) + "T".repeat(500);
  const cut = elideMiddle(long, 200);
  assert.ok(cut.length <= 200, "respects the budget");
  assert.ok(cut.startsWith("H"), "keeps the head");
  assert.ok(cut.endsWith("T"), "keeps the tail");
  assert.match(cut, /truncated/, "marks the cut");
}

// --------------------------------------------------- message-level reduction

{
  const messages: Message[] = [
    { role: "user", content: "please refactor the parser" },
    { role: "assistant", content: "looking" },
    { role: "tool", content: "X".repeat(50_000), toolCallId: "t1", name: "read_file" },
    { role: "assistant", content: "done" },
  ];
  const { messages: out, omitted, shortened } = truncateMessagesFairly(messages, 5_000);

  assert.equal(out[0]!.content, "please refactor the parser", "the small user message is kept whole");
  assert.equal(out[1]!.content, "looking", "small assistant message kept whole");
  assert.equal(out[3]!.content, "done", "small assistant message kept whole");
  assert.ok(out[2]!.content.length < 50_000, "the huge tool result was shrunk");
  assert.equal(shortened, 1, "exactly one message was shortened");
  assert.equal(omitted, 0, "nothing needed to be omitted whole");
  assert.equal(out[2]!.toolCallId, "t1", "tool call id preserved");
  assert.equal(out[2]!.name, "read_file", "tool name preserved");
}

{
  // With a budget too small to leave anything meaningful, messages become
  // placeholders that still record what was there.
  const messages: Message[] = [
    { role: "tool", content: "A".repeat(10_000), toolCallId: "t1", name: "grep" },
    { role: "tool", content: "B".repeat(10_000), toolCallId: "t2", name: "grep" },
  ];
  const { messages: out, omitted } = truncateMessagesFairly(messages, 100);
  assert.equal(omitted, 2, "both are omitted");
  assert.match(out[0]!.content, /\[omitted tool message, 10000 chars\]/);
  assert.ok(out[0]!.content.length < MIN_USEFUL_CHARS, "placeholders are small");
}

// ---------------------------------------------------------- through the Agent

{
  const provider = new ScriptProvider();
  // One ancient round whose tool result is enormous, then several small rounds.
  const giant = "G".repeat(120_000);
  const initialMessages: Message[] = [
    { role: "user", content: "FIRST-REQUEST: analyze the whole tree" },
    { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read_file", arguments: { path: "big.ts" } }] },
    { role: "tool", content: giant, toolCallId: "t1", name: "read_file" },
    { role: "assistant", content: "that file is large" },
    { role: "user", content: "SECOND-REQUEST: now summarize it" },
    { role: "assistant", content: "summarized" },
  ];

  const agent = new Agent({
    provider,
    tools: [],
    workspaceRoot: os.tmpdir(),
    approvalPolicy: "auto",
    systemPrompt: "BASE-PROMPT",
    initialMessages,
    maxContextChars: 20_000,
    // Isolate the fallback: LLM compaction is the preferred path and would
    // otherwise handle this before trimming gets a chance.
    autoCompact: false,
  });

  provider.queue = [{ text: "ok", toolCalls: [] }];
  await agent.run("THIRD-REQUEST: what did you find?");

  const sent = provider.lastMessages;
  const joined = sent.map((m) => m.content).join("\n");

  // The oldest round survived: previously it would have been dropped whole.
  assert.match(joined, /FIRST-REQUEST/, "the oldest user request was not dropped");
  assert.match(joined, /SECOND-REQUEST/, "the middle user request was not dropped");
  assert.match(joined, /THIRD-REQUEST/, "the current request is intact");
  assert.equal(sent[0]!.content, "BASE-PROMPT", "the system prompt is untouched");

  // The giant message is what actually shrank.
  const giantMsg = sent.find((m) => m.role === "tool" && m.name === "read_file")!;
  assert.ok(giantMsg, "the tool message is still present (paired with its call)");
  assert.ok(giantMsg.content.length < 120_000, "the giant result was reduced");
  assert.equal(giantMsg.toolCallId, "t1", "tool-call pairing survived");

  // The reduction is announced.
  assert.match(joined, /Earlier history was reduced to fit the context budget/, "notice present");

  // And the whole thing now fits.
  const total = sent.reduce(
    (n, m) => n + m.content.length + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0),
    0,
  );
  assert.ok(total <= 20_000 * 1.05, `context is within budget (${total})`);
}

{
  // A conversation already inside its budget is left completely alone.
  const provider = new ScriptProvider();
  const agent = new Agent({
    provider,
    tools: [],
    workspaceRoot: os.tmpdir(),
    approvalPolicy: "auto",
    systemPrompt: "BASE",
    initialMessages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ],
    maxContextChars: 100_000,
    autoCompact: false,
  });
  provider.queue = [{ text: "ok", toolCalls: [] }];
  await agent.run("still here?");
  const joined = provider.lastMessages.map((m) => m.content).join("\n");
  assert.doesNotMatch(joined, /reduced to fit/, "no notice when nothing was reduced");
  assert.doesNotMatch(joined, /omitted/, "no placeholders when nothing was reduced");
}

process.stdout.write("test-fair-truncate: ALL PASS\n");
