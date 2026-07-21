/**
 * Deterministic test: ask_user multi-select plumbing + non-interactive answer.
 * Covers: the agent forwards `allow_multiple` (and options) from the tool call to
 * the onAskUser callback and feeds the answer back as a tool result; when
 * allow_multiple is absent it is falsy; and autoAnswerAsk (the --auto / no-TTY
 * handler) returns immediately without blocking. No network, no real prompts.
 *
 * Run: node --import tsx scripts/test-askuser.mts
 */
import assert from "node:assert/strict";
import { Agent, type ChatParams, type ChatResult, type LLMProvider } from "@scissor/core";
import { autoAnswerAsk, autoApprove } from "../packages/cli/src/ui/prompts.js";

class ScriptProvider implements LLMProvider {
  id = "deepseek" as const;
  model = "script";
  queue: ChatResult[] = [];
  async chat(_p: ChatParams): Promise<ChatResult> {
    return this.queue.shift() ?? { text: "done", toolCalls: [] };
  }
}

function makeAgent(provider: ScriptProvider): Agent {
  return new Agent({
    provider,
    tools: [],
    workspaceRoot: process.cwd(),
    approvalPolicy: "auto",
    systemPrompt: "s",
  });
}

// 1. allow_multiple + options forwarded to onAskUser; multi-answer fed back.
{
  const provider = new ScriptProvider();
  provider.queue = [
    {
      text: "",
      toolCalls: [
        {
          id: "q",
          name: "ask_user",
          arguments: { question: "Pick some", options: ["A", "B", "C"], allow_multiple: true },
        },
      ],
    },
    { text: "done", toolCalls: [] },
  ];
  let seen: { question?: string; options?: string[]; allowMultiple?: boolean } = {};
  const agent = makeAgent(provider);
  await agent.run("x", {
    onAskUser: async (question, options, allowMultiple) => {
      seen = { question, options, allowMultiple };
      return "A, C";
    },
  });
  assert.equal(seen.allowMultiple, true, "allow_multiple forwarded");
  assert.deepEqual(seen.options, ["A", "B", "C"], "options forwarded");
  const toolMsg = agent
    .getTranscript()
    .find((m) => m.role === "tool" && m.toolCallId === "q");
  assert.ok(toolMsg, "tool result recorded");
  assert.match(String(toolMsg!.content), /User answered: A, C/);
}

// 2. allow_multiple omitted -> falsy at the callback.
{
  const provider = new ScriptProvider();
  provider.queue = [
    {
      text: "",
      toolCalls: [{ id: "q", name: "ask_user", arguments: { question: "Pick", options: ["A", "B"] } }],
    },
    { text: "done", toolCalls: [] },
  ];
  let seenMultiple: boolean | undefined = true;
  const agent = makeAgent(provider);
  await agent.run("x", {
    onAskUser: async (_q, _o, allowMultiple) => {
      seenMultiple = allowMultiple;
      return "A";
    },
  });
  assert.ok(!seenMultiple, "allowMultiple should be falsy when not provided");
}

// 3. autoAnswerAsk returns immediately (non-blocking) with useful guidance.
{
  const withOpts = await autoAnswerAsk("Which one?", ["x", "y"]);
  assert.match(withOpts, /best judgment/i);
  assert.match(withOpts, /x \| y/, "surfaces the options to the agent");

  const freeform = await autoAnswerAsk("Anything?");
  assert.match(freeform, /best judgment/i);
}

// 4. autoApprove (the --auto / no-TTY approval handler) never blocks: ordinary
// mutations are approved so headless work proceeds, but genuinely destructive
// actions are rejected (never silently run without a human), handed back to the
// agent as a non-error. Regression guard for the headless approval-hang bug.
{
  const call = { id: "t", name: "edit_file", arguments: {} };
  const safe = await autoApprove(call, { summary: "edit file", dangerous: false });
  assert.equal(safe, "approve", "safe mutation auto-approved headlessly");

  const danger = await autoApprove(
    { id: "t", name: "run_shell", arguments: {} },
    { summary: "rm -rf /", dangerous: true },
  );
  assert.equal(danger, "reject", "destructive action rejected, not silently run");
}

process.stdout.write("test-askuser: ALL PASS\n");
