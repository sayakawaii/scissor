/**
 * Deterministic test: the structured task list (todo_write).
 * Covers: creating items, the list pinned into the system prompt, merge
 * semantics (patch by id, append unknown ids, untouched items persist),
 * merge:false replacing the list, rejecting two in_progress items, rejecting a
 * new item with no content, lenient argument coercion (stringified array,
 * string boolean, mixed-case status), survival across compaction/trim, reset(),
 * and restore from initialTodos (resume round-trip). No network.
 *
 * Run: node --import tsx scripts/test-todos.mts
 */
import assert from "node:assert/strict";
import os from "node:os";
import {
  Agent,
  todoWriteTool,
  type ChatParams,
  type ChatResult,
  type LLMProvider,
  type TodoItem,
  type ToolResult,
} from "@scissor/core";

class ScriptProvider implements LLMProvider {
  id = "deepseek" as const;
  model = "script";
  queue: ChatResult[] = [];
  async chat(_p: ChatParams): Promise<ChatResult> {
    return this.queue.shift() ?? { text: "done", toolCalls: [] };
  }
}

function makeAgent(initialTodos?: TodoItem[]): { agent: Agent; provider: ScriptProvider } {
  const provider = new ScriptProvider();
  const agent = new Agent({
    provider,
    tools: [todoWriteTool],
    workspaceRoot: os.tmpdir(),
    approvalPolicy: "auto",
    systemPrompt: "BASE-PROMPT",
    ...(initialTodos ? { initialTodos } : {}),
  });
  return { agent, provider };
}

/** Run one todo_write call directly and return its tool result. */
async function write(agent: Agent, args: Record<string, unknown>): Promise<ToolResult> {
  return agent.runTool("todo_write", args);
}

const { agent, provider } = makeAgent();
const sys = () => agent.getMessages()[0]!.content;

// 1. The guidance block is present even with an empty list (the tool is enabled).
assert.match(sys(), /<task_list>[\s\S]*<\/task_list>/, "block present when tool enabled");
assert.match(sys(), /- \(no tasks\)/, "empty state marker");
assert.ok(sys().startsWith("BASE-PROMPT"), "base prompt preserved");

// 2. Creating items populates state and the system prompt.
let r = await write(agent, {
  todos: [
    { id: "a", content: "write the failing test", status: "in_progress" },
    { id: "b", content: "implement the feature", status: "pending" },
    { id: "c", content: "update the docs", status: "pending" },
  ],
});
assert.equal(r.isError, undefined, "valid write succeeds");
assert.equal(agent.getTodos().length, 3);
assert.match(sys(), /\[~\] a: write the failing test/, "in_progress marker pinned");
assert.match(sys(), /\[ \] b: implement the feature/, "pending marker pinned");
assert.match(sys(), /3 unfinished task\(s\)/, "unfinished count nudge");

// 3. Merge (the default) patches by id; untouched items keep their state.
r = await write(agent, {
  todos: [
    { id: "a", status: "completed" },
    { id: "b", status: "in_progress" },
  ],
});
assert.equal(r.isError, undefined);
const byId = new Map(agent.getTodos().map((t) => [t.id, t]));
assert.equal(byId.get("a")!.status, "completed");
assert.equal(byId.get("a")!.content, "write the failing test", "content preserved on patch");
assert.equal(byId.get("b")!.status, "in_progress");
assert.equal(byId.get("c")!.status, "pending", "untouched item unchanged");
assert.equal(agent.getTodos().length, 3, "patch does not duplicate items");

// 4. Merge appends unknown ids, preserving existing order.
r = await write(agent, { todos: [{ id: "d", content: "ship it", status: "pending" }] });
assert.equal(r.isError, undefined);
assert.deepEqual(
  agent.getTodos().map((t) => t.id),
  ["a", "b", "c", "d"],
  "new id appended at the end",
);

// 5. Two in_progress items are rejected, and state is left untouched.
r = await write(agent, {
  todos: [
    { id: "c", status: "in_progress" },
  ],
});
assert.equal(r.isError, true, "second in_progress rejected");
assert.match(r.content, /in_progress/);
assert.equal(
  agent.getTodos().find((t) => t.id === "c")!.status,
  "pending",
  "rejected write did not mutate state",
);

// 6. A new item with no content is rejected.
r = await write(agent, { todos: [{ id: "brand-new", status: "pending" }] });
assert.equal(r.isError, true, "new item without content rejected");
assert.match(r.content, /needs 'content'/);

// 7. An invalid status is rejected.
r = await write(agent, { todos: [{ id: "a", content: "x", status: "almost-done" }] });
assert.equal(r.isError, true, "invalid status rejected");
assert.match(r.content, /invalid status/);

// 8. merge:false replaces the whole list.
r = await write(agent, {
  todos: [{ id: "only", content: "the one remaining task", status: "pending" }],
  merge: false,
});
assert.equal(r.isError, undefined);
assert.deepEqual(agent.getTodos().map((t) => t.id), ["only"], "list replaced");

// 9. Lenient coercion: a stringified array, a string boolean, a mixed-case status.
{
  const { agent: a2 } = makeAgent();
  const res = await write(a2, {
    todos: JSON.stringify([
      { id: "x", content: "coerced task", status: "IN_PROGRESS" },
      { id: "y", content: "second", status: "pending" },
    ]),
    merge: "false",
  });
  assert.equal(res.isError, undefined, "stringified array coerced");
  assert.equal(a2.getTodos().length, 2);
  assert.equal(a2.getTodos()[0]!.status, "in_progress", "status case normalized");
}

// 10. The list survives compaction and trimming (it lives in the system message).
{
  const p = new ScriptProvider();
  let summarized = 0;
  const small = new Agent({
    provider: p,
    tools: [todoWriteTool],
    workspaceRoot: os.tmpdir(),
    approvalPolicy: "auto",
    systemPrompt: "BASE",
    maxContextChars: 300,
    summarize: async () => {
      summarized++;
      return "OLD STUFF SUMMARY";
    },
  });
  await write(small, { todos: [{ id: "keep", content: "SURVIVE-ME", status: "pending" }] });
  for (let i = 0; i < 3; i++) await small.run("x".repeat(200));
  assert.match(
    small.getMessages()[0]!.content,
    /SURVIVE-ME/,
    "task list survives compaction/trim",
  );
  assert.ok(summarized > 0, "compaction actually ran");
}

// 11. The model can drive it through a normal turn.
{
  const { agent: a3, provider: p3 } = makeAgent();
  p3.queue = [
    {
      text: "",
      toolCalls: [
        {
          id: "t1",
          name: "todo_write",
          arguments: { todos: [{ id: "s1", content: "step one", status: "in_progress" }] },
        },
      ],
    },
    { text: "ok", toolCalls: [] },
  ];
  await a3.run("do a multi-step thing");
  assert.equal(a3.getTodos().length, 1, "tool call intercepted in the loop");
  assert.equal(a3.getTodos()[0]!.status, "in_progress");
}

// 12. reset() clears the list; initialTodos restores it (resume round-trip).
agent.reset();
assert.deepEqual(agent.getTodos(), [], "todos cleared on reset");
assert.match(sys(), /- \(no tasks\)/, "empty after reset");
{
  const { agent: restored } = makeAgent([
    { id: "r1", content: "resumed task", status: "in_progress" },
  ]);
  assert.equal(restored.getTodos()[0]!.content, "resumed task");
  assert.match(restored.getMessages()[0]!.content, /resumed task/, "restored list rendered");
}

// 13. Without the tool, no task-list block is added.
{
  const bare = new Agent({
    provider: new ScriptProvider(),
    tools: [],
    workspaceRoot: os.tmpdir(),
    approvalPolicy: "auto",
    systemPrompt: "JUST-BASE",
  });
  assert.equal(bare.getMessages()[0]!.content, "JUST-BASE", "no block without the tool");
}

process.stdout.write("test-todos: ALL PASS\n");
