/**
 * Deterministic test: the structured working-memory scratchpad.
 * Covers: update_scratchpad merges into state, the state is pinned into the
 * system prompt, partial updates merge (fields persist), clearing a field,
 * survival across context compaction/trim, reset(), and restore from an
 * initialScratchpad (resume round-trip). No network.
 *
 * Run: node --import tsx scripts/test-scratchpad.mts
 */
import assert from "node:assert/strict";
import os from "node:os";
import {
  Agent,
  updateScratchpadTool,
  type ChatParams,
  type ChatResult,
  type LLMProvider,
} from "@scissor/core";

/** Provider that plays back a queue of scripted responses. */
class ScriptProvider implements LLMProvider {
  id = "deepseek" as const;
  model = "script";
  queue: ChatResult[] = [];
  async chat(_p: ChatParams): Promise<ChatResult> {
    return this.queue.shift() ?? { text: "done", toolCalls: [] };
  }
}

const sys = () => (agent.getMessages()[0]!.content);

// 1. update_scratchpad populates state and the system prompt.
const provider = new ScriptProvider();
const agent = new Agent({
  provider,
  tools: [updateScratchpadTool],
  workspaceRoot: os.tmpdir(),
  approvalPolicy: "auto",
  systemPrompt: "BASE-PROMPT",
});

// Empty scratchpad still renders the guidance block (tool is available).
assert.match(sys(), /\[Working memory \/ scratchpad\]/, "block present when tool enabled");
assert.match(sys(), /- \(empty\)/, "empty state marker");

provider.queue = [
  {
    text: "",
    toolCalls: [
      {
        id: "c1",
        name: "update_scratchpad",
        arguments: {
          goal: "build feature X",
          next_step: "write the failing test",
          files: ["src/x.ts", "test/x.test.ts"],
          last_error: "TS2322: type mismatch",
          note: "prefer the existing helper",
        },
      },
    ],
  },
  { text: "ok", toolCalls: [] },
];
await agent.run("please do X");

const sp = agent.getScratchpad();
assert.equal(sp.goal, "build feature X");
assert.equal(sp.nextStep, "write the failing test");
assert.equal(sp.lastError, "TS2322: type mismatch");
assert.deepEqual(sp.files, ["src/x.ts", "test/x.test.ts"]);
assert.deepEqual(sp.notes, ["prefer the existing helper"]);
assert.match(sys(), /Goal: build feature X/, "goal pinned into system prompt");
assert.match(sys(), /Files in play: src\/x\.ts, test\/x\.test\.ts/);
assert.ok(sys().startsWith("BASE-PROMPT"), "base prompt preserved");

// 2. Partial update merges: change only next_step; other fields persist.
provider.queue = [
  {
    text: "",
    toolCalls: [
      { id: "c2", name: "update_scratchpad", arguments: { next_step: "implement it" } },
    ],
  },
  { text: "ok", toolCalls: [] },
];
await agent.run("progress");
assert.equal(agent.getScratchpad().goal, "build feature X", "goal persists across updates");
assert.equal(agent.getScratchpad().nextStep, "implement it", "next step updated");

// 3. Clearing a field: pass empty string.
provider.queue = [
  {
    text: "",
    toolCalls: [
      { id: "c3", name: "update_scratchpad", arguments: { last_error: "" } },
    ],
  },
  { text: "ok", toolCalls: [] },
];
await agent.run("fixed the error");
assert.equal(agent.getScratchpad().lastError, undefined, "last error cleared");
assert.doesNotMatch(sys(), /Last error:/, "cleared field not rendered");

// 4. Survival across compaction/trim: the scratchpad is in the system message,
//    which is never compacted or trimmed.
{
  const p = new ScriptProvider();
  let summarized = 0;
  const smallAgent = new Agent({
    provider: p,
    tools: [updateScratchpadTool],
    workspaceRoot: os.tmpdir(),
    approvalPolicy: "auto",
    systemPrompt: "BASE",
    maxContextChars: 300,
    summarize: async () => {
      summarized++;
      return "OLD STUFF SUMMARY";
    },
  });
  // Set a goal first.
  p.queue = [
    { text: "", toolCalls: [{ id: "s", name: "update_scratchpad", arguments: { goal: "SURVIVE-ME" } }] },
    { text: "ok", toolCalls: [] },
  ];
  await smallAgent.run("start");
  // Now drive a few big rounds to blow past the budget and force compaction/trim.
  for (let i = 0; i < 3; i++) {
    await smallAgent.run("x".repeat(200));
  }
  assert.match(smallAgent.getMessages()[0]!.content, /Goal: SURVIVE-ME/, "goal survives compaction/trim");
  assert.ok(summarized > 0, "compaction actually ran");
}

// 5. reset() clears the scratchpad and its rendering.
agent.reset();
assert.deepEqual(agent.getScratchpad(), {}, "scratchpad cleared on reset");
assert.match(sys(), /- \(empty\)/, "empty after reset");

// 6. Restore from an initialScratchpad (resume round-trip).
{
  const restored = new Agent({
    provider: new ScriptProvider(),
    tools: [updateScratchpadTool],
    workspaceRoot: os.tmpdir(),
    approvalPolicy: "auto",
    systemPrompt: "BASE",
    initialScratchpad: { goal: "resumed goal", files: ["a.ts"] },
  });
  assert.equal(restored.getScratchpad().goal, "resumed goal");
  assert.match(restored.getMessages()[0]!.content, /Goal: resumed goal/, "restored goal rendered");
}

// 7. When the tool is not available, no scratchpad block is added.
{
  const noTool = new Agent({
    provider: new ScriptProvider(),
    tools: [],
    workspaceRoot: os.tmpdir(),
    approvalPolicy: "auto",
    systemPrompt: "JUST-BASE",
  });
  assert.equal(noTool.getMessages()[0]!.content, "JUST-BASE", "no block without the tool");
}

process.stdout.write("test-scratchpad: ALL PASS\n");
