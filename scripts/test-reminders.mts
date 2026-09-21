/**
 * Deterministic test: the system-reminder pipeline and token budgeting.
 *
 * Covers: reminders firing on a consecutive-failure streak, on a task list with
 * nothing in progress, on a stale task list, and on unverified edits; reminders
 * being appended to the LAST tool result of a turn (not injected as a new
 * message, which would break tool-call pairing); a success clearing a streak;
 * the estimateTokens seam and its char/token conversions. No network.
 *
 * Run: node --import tsx scripts/test-reminders.mts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Agent,
  charsPerToken,
  charsToTokens,
  defaultReminders,
  estimateConversationTokens,
  estimateMessageTokens,
  estimateTokens,
  ReminderTracker,
  renderReminders,
  todoWriteTool,
  tokensToChars,
  type ChatParams,
  type ChatResult,
  type LLMProvider,
  type Message,
  type Tool,
  type TodoItem,
} from "@scissor/core";

class ScriptProvider implements LLMProvider {
  id = "deepseek" as const;
  model = "script";
  queue: ChatResult[] = [];
  async chat(_p: ChatParams): Promise<ChatResult> {
    return this.queue.shift() ?? { text: "done", toolCalls: [] };
  }
}

const rules = defaultReminders();

// ------------------------------------------------------- consecutive failures

{
  const tracker = new ReminderTracker();
  // Two failures is a hiccup: no nudge yet.
  tracker.record("run_shell", true);
  tracker.record("run_shell", true);
  assert.equal(
    renderReminders(rules, tracker.context("run_shell", true, [])),
    "",
    "two failures do not trigger a reminder",
  );

  // Three is a pattern worth naming.
  tracker.record("run_shell", true);
  const fired = renderReminders(rules, tracker.context("run_shell", true, []));
  assert.match(fired, /\[system-reminder\]/, "the block is tagged");
  assert.match(fired, /3 consecutive run_shell calls have failed/);
  assert.match(fired, /change approach/, "it says what to do instead");

  // A success clears the streak, so the nudge stops.
  tracker.record("run_shell", false);
  assert.equal(
    renderReminders(rules, tracker.context("run_shell", false, [])),
    "",
    "a success clears the failure streak",
  );

  // Streaks are per tool: another tool's failures do not accumulate here.
  const other = new ReminderTracker();
  other.record("read_file", true);
  other.record("run_shell", true);
  other.record("read_file", true);
  assert.equal(
    renderReminders(rules, other.context("read_file", true, [])),
    "",
    "failures of different tools are counted separately",
  );
}

// --------------------------------------------------------------- todo nudges

{
  const idle: TodoItem[] = [
    { id: "a", content: "step one", status: "completed" },
    { id: "b", content: "step two", status: "pending" },
  ];
  const tracker = new ReminderTracker();
  tracker.record("read_file", false);
  const fired = renderReminders(rules, tracker.context("read_file", false, idle));
  assert.match(fired, /1 pending task\(s\) and none in progress/, "idle list is flagged");

  // With one in progress there is nothing to say.
  const active: TodoItem[] = [
    { id: "a", content: "step one", status: "in_progress" },
    { id: "b", content: "step two", status: "pending" },
  ];
  assert.equal(
    renderReminders(rules, tracker.context("read_file", false, active)),
    "",
    "an in_progress task silences the idle nudge",
  );

  // An all-done list is silent too.
  const done: TodoItem[] = [{ id: "a", content: "step one", status: "completed" }];
  assert.equal(
    renderReminders(rules, tracker.context("read_file", false, done)),
    "",
    "a finished list is silent",
  );
}

{
  // A list left untouched across many calls gets a staleness nudge.
  const tracker = new ReminderTracker();
  const todos: TodoItem[] = [{ id: "a", content: "still going", status: "in_progress" }];
  for (let i = 0; i < 20; i++) tracker.record("read_file", false);
  const fired = renderReminders(rules, tracker.context("read_file", false, todos));
  assert.match(fired, /have not updated your task list in 20 tool calls/);

  // Writing the list restarts the clock.
  tracker.noteTodoWrite();
  assert.equal(
    renderReminders(rules, tracker.context("read_file", false, todos)),
    "",
    "writing the task list clears the staleness nudge",
  );
}

// --------------------------------------------------------- unverified edits

{
  const tracker = new ReminderTracker();
  for (let i = 0; i < 5; i++) tracker.noteEdit();
  const fired = renderReminders(rules, tracker.context("edit_file", false, []));
  assert.match(fired, /edited 5 file\(s\) without verifying/);
  assert.match(fired, /diagnostics/, "it names the checking tool");

  tracker.noteVerified();
  assert.equal(
    renderReminders(rules, tracker.context("edit_file", false, [])),
    "",
    "verifying clears the nudge",
  );
}

// A misbehaving reminder is skipped rather than breaking the turn.
{
  const tracker = new ReminderTracker();
  const broken = [
    {
      name: "explodes",
      shouldTrigger() {
        throw new Error("boom");
      },
      generate() {
        return "never";
      },
    },
    ...rules,
  ];
  for (let i = 0; i < 5; i++) tracker.noteEdit();
  const fired = renderReminders(broken, tracker.context("edit_file", false, []));
  assert.match(fired, /without verifying/, "the working reminders still fire");
  assert.doesNotMatch(fired, /never/);
}

// ------------------------------------------------- appended in the agent loop

{
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-reminders-"));
  const failing: Tool = {
    name: "flaky",
    description: "always fails",
    parameters: { type: "object", properties: {} },
    async run() {
      return { content: "nope", isError: true };
    },
  };
  const provider = new ScriptProvider();
  const agent = new Agent({
    provider,
    tools: [failing, todoWriteTool],
    workspaceRoot,
    approvalPolicy: "auto",
    systemPrompt: "BASE",
  });

  // Three failing calls across three turns; the third turn carries the nudge.
  for (let turn = 1; turn <= 3; turn++) {
    provider.queue.push({
      text: "",
      toolCalls: [{ id: `c${turn}`, name: "flaky", arguments: { attempt: turn } }],
    });
  }
  provider.queue.push({ text: "giving up", toolCalls: [] });
  await agent.run("try the flaky thing");

  const toolMessages = agent.getMessages().filter((m) => m.role === "tool");
  assert.equal(toolMessages.length, 3, "one tool message per call");
  assert.doesNotMatch(toolMessages[0]!.content, /system-reminder/, "no nudge on the first failure");
  assert.match(toolMessages[2]!.content, /\[system-reminder\]/, "the third failure is flagged");
  assert.match(toolMessages[2]!.content, /3 consecutive flaky calls have failed/);
  // The reminder rides on the existing result, so pairing is untouched.
  assert.equal(toolMessages[2]!.toolCallId, "c3", "tool call id preserved");
  assert.ok(toolMessages[2]!.content.startsWith("nope"), "the real result comes first");

  await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
}

{
  // With several calls in one turn the nudge lands on the last result only.
  const failing: Tool = {
    name: "flaky",
    description: "always fails",
    mutating: false,
    parameters: { type: "object", properties: {} },
    async run() {
      return { content: "nope", isError: true };
    },
  };
  const provider = new ScriptProvider();
  const agent = new Agent({
    provider,
    tools: [failing],
    workspaceRoot: os.tmpdir(),
    approvalPolicy: "auto",
    systemPrompt: "BASE",
  });
  provider.queue = [
    {
      text: "",
      toolCalls: [
        { id: "a", name: "flaky", arguments: { n: 1 } },
        { id: "b", name: "flaky", arguments: { n: 2 } },
        { id: "c", name: "flaky", arguments: { n: 3 } },
      ],
    },
    { text: "done", toolCalls: [] },
  ];
  await agent.run("fan out");
  const toolMessages = agent.getMessages().filter((m) => m.role === "tool");
  assert.equal(toolMessages.length, 3);
  const withReminder = toolMessages.filter((m) => m.content.includes("system-reminder"));
  assert.equal(withReminder.length, 1, "exactly one message carries the nudge");
  assert.equal(withReminder[0]!.toolCallId, "c", "it is the last result of the turn");
}

// ------------------------------------------------------------ token estimation

{
  assert.equal(estimateTokens(""), 0, "empty text costs nothing");
  assert.ok(estimateTokens("hello world") > 0);

  // Longer text costs more, monotonically.
  assert.ok(estimateTokens("x".repeat(1000)) > estimateTokens("x".repeat(100)));

  // Per-family ratios differ, and a stingier ratio means more tokens.
  assert.notEqual(charsPerToken("glm"), charsPerToken("gpt"));
  assert.ok(
    estimateTokens("x".repeat(3000), "glm") > estimateTokens("x".repeat(3000), "gpt"),
    "a lower chars-per-token ratio yields a higher token estimate",
  );

  // The conversions round-trip within one token.
  for (const provider of ["claude", "gpt", "deepseek", "glm"] as const) {
    const chars = 10_000;
    const tokens = charsToTokens(chars, provider);
    const back = tokensToChars(tokens, provider);
    assert.ok(
      Math.abs(back - chars) <= charsPerToken(provider),
      `${provider} conversion round-trips (${chars} -> ${tokens} -> ${back})`,
    );
  }

  // A message costs its content plus its tool calls plus per-message overhead.
  const plain: Message = { role: "user", content: "hi" };
  const withCalls: Message = {
    role: "assistant",
    content: "hi",
    toolCalls: [{ id: "t", name: "read_file", arguments: { path: "a/very/long/path.ts" } }],
  };
  assert.ok(estimateMessageTokens(plain) > 0, "overhead is counted even for tiny content");
  assert.ok(
    estimateMessageTokens(withCalls) > estimateMessageTokens(plain),
    "tool call arguments are counted",
  );
  assert.equal(
    estimateConversationTokens([plain, withCalls]),
    estimateMessageTokens(plain) + estimateMessageTokens(withCalls),
    "a conversation is the sum of its messages",
  );
  assert.equal(estimateConversationTokens([]), 0);
}

// A token budget and the equivalent character budget behave the same.
{
  const long = "Z".repeat(80_000);
  const build = (opts: { maxContextChars?: number; maxContextTokens?: number }) =>
    new Agent({
      provider: new ScriptProvider(),
      tools: [],
      workspaceRoot: os.tmpdir(),
      approvalPolicy: "auto",
      systemPrompt: "BASE",
      initialMessages: [
        { role: "user", content: "old request" },
        { role: "assistant", content: long },
        { role: "user", content: "new request" },
      ],
      autoCompact: false,
      ...opts,
    });

  const byChars = build({ maxContextChars: 20_000 });
  const byTokens = build({ maxContextTokens: charsToTokens(20_000, "deepseek") });
  for (const agent of [byChars, byTokens]) {
    await agent.run("go");
    const joined = agent.getMessages().map((m) => m.content).join("\n");
    assert.match(joined, /reduced to fit the context budget/, "both spellings trigger reduction");
    assert.match(joined, /old request/, "and both preserve the old request");
  }
}

process.stdout.write("test-reminders: ALL PASS\n");
