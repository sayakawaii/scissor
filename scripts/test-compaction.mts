/**
 * Deterministic test: context compaction. A fake summarizer folds old rounds
 * into a summary once the conversation exceeds the threshold, while the most
 * recent round is preserved. Also covers manual compact(). No network.
 *
 * Run: node --import tsx scripts/test-compaction.mts
 */
import assert from "node:assert/strict";
import os from "node:os";
import {
  Agent,
  type ChatParams,
  type ChatResult,
  type LLMProvider,
  type Message,
} from "@scissor/core";

// Provider that just echoes with no tool calls, so each run completes in one turn.
class EchoProvider implements LLMProvider {
  id = "deepseek" as const;
  model = "echo";
  calls = 0;
  async chat(_p: ChatParams): Promise<ChatResult> {
    this.calls++;
    return { text: `reply ${this.calls}`, toolCalls: [] };
  }
}

let summarizeCalls = 0;
let lastSlice: Message[] = [];
const summarize = async (msgs: Message[]): Promise<string> => {
  summarizeCalls++;
  lastSlice = msgs;
  return "SUMMARY_OF_OLD_STUFF";
};

const provider = new EchoProvider();
const agent = new Agent({
  provider,
  tools: [],
  workspaceRoot: os.tmpdir(),
  approvalPolicy: "auto",
  systemPrompt: "sys",
  maxContextChars: 300,
  summarize,
});

const pad = (label: string) => label + " " + "x".repeat(150);

// Round 1 — below threshold, no compaction yet.
await agent.run(pad("UNIQUE_ONE"));
assert.equal(summarizeCalls, 0, "no compaction on the first small round");

// Round 2 — now over threshold at the start of the loop -> auto-compact.
await agent.run(pad("UNIQUE_TWO"));
assert.ok(summarizeCalls >= 1, "auto-compaction summarized old rounds");
assert.ok(lastSlice.length >= 2, "summarizer received the old slice");

const transcript = agent.getTranscript();
const joined = transcript.map((m) => `${m.role}:${m.content}`).join("\n");
assert.ok(joined.includes("[Summary of earlier conversation]"), "summary marker inserted");
assert.ok(joined.includes("SUMMARY_OF_OLD_STUFF"), "summary body inserted");
assert.ok(joined.includes("UNIQUE_TWO"), "most recent round preserved");
assert.ok(!joined.includes("UNIQUE_ONE"), "oldest round folded away");

// Manual compact: summarize everything except the latest round.
await agent.run(pad("UNIQUE_THREE"));
const before = summarizeCalls;
const did = await agent.compact();
assert.ok(did, "manual compact ran");
assert.equal(summarizeCalls, before + 1, "manual compact summarized once");
const t2 = agent.getTranscript().map((m) => `${m.role}:${m.content}`).join("\n");
assert.ok(t2.includes("UNIQUE_THREE"), "latest round kept after manual compact");

// compact() with only one round left should be a no-op.
agent.reset();
await agent.run("just one round");
assert.equal(await agent.compact(), false, "nothing to compact with a single round");

// The rolling summary must survive the hard trim fallback, even when the
// summary itself is larger than maxContextChars (regression guard).
{
  const bigSummary = "S".repeat(500);
  const agent2 = new Agent({
    provider: new EchoProvider(),
    tools: [],
    workspaceRoot: os.tmpdir(),
    approvalPolicy: "auto",
    systemPrompt: "sys",
    maxContextChars: 300,
    summarize: async () => bigSummary,
  });
  for (const label of ["AAA", "BBB", "CCC", "DDD", "EEE"]) {
    await agent2.run(label + " " + "y".repeat(120));
  }
  const tr = agent2.getTranscript().map((m) => m.content).join("\n");
  assert.ok(
    tr.includes("[Summary of earlier conversation]"),
    "rolling summary preserved through trimming",
  );
}

process.stdout.write("\x1b[32mtest-compaction: ALL PASS\x1b[0m\n");
