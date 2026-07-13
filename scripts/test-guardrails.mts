/**
 * Deterministic test: the guardrail pipeline.
 * Covers: a custom guardrail can veto a tool before it runs (tool.run is not
 * called and the veto is fed back to the model), an afterTool hook can transform
 * a result, and the built-in oscillation guard blocks the exact same call after
 * it has failed `limit` times (and a success clears the streak). No network.
 *
 * Run: node --import tsx scripts/test-guardrails.mts
 */
import assert from "node:assert/strict";
import os from "node:os";
import {
  Agent,
  createApprovalGuard,
  createOscillationGuard,
  createTddGuard,
  type ChatParams,
  type ChatResult,
  type GuardContext,
  type Guardrail,
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

// A tool whose behavior is controlled by the test.
function makeTool(name: string, run: Tool["run"]): Tool {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    run,
  };
}

// 1. beforeTool veto blocks execution; tool.run is never called.
{
  let ran = 0;
  const tool = makeTool("danger", async () => {
    ran++;
    return { content: "ran" };
  });
  const guard: Guardrail = {
    name: "policy",
    beforeTool: (call) =>
      call.name === "danger" ? { allow: false, reason: "not allowed" } : { allow: true },
  };
  const provider = new ScriptProvider();
  provider.queue = [
    { text: "", toolCalls: [{ id: "1", name: "danger", arguments: {} }] },
    { text: "understood, blocked", toolCalls: [] },
  ];
  const agent = new Agent({
    provider,
    tools: [tool],
    workspaceRoot: os.tmpdir(),
    approvalPolicy: "auto",
    systemPrompt: "s",
    guardrails: [guard],
  });
  await agent.run("do the danger");
  assert.equal(ran, 0, "vetoed tool did not run");
  const msg = agent.getTranscript().find((m) => m.role === "tool" && m.name === "danger");
  assert.match(msg!.content, /Blocked by guardrail "policy": not allowed/, "veto fed back");
}

// 2. afterTool transforms the result.
{
  const tool = makeTool("leaky", async () => ({ content: "token=sk-SECRET-123 rest" }));
  const redactor: Guardrail = {
    name: "redact",
    afterTool: (_call, result) => ({
      ...result,
      content: result.content.replace(/sk-[A-Za-z0-9-]+/g, "sk-***"),
    }),
  };
  const provider = new ScriptProvider();
  provider.queue = [
    { text: "", toolCalls: [{ id: "1", name: "leaky", arguments: {} }] },
    { text: "ok", toolCalls: [] },
  ];
  const agent = new Agent({
    provider,
    tools: [tool],
    workspaceRoot: os.tmpdir(),
    approvalPolicy: "auto",
    systemPrompt: "s",
    guardrails: [redactor],
  });
  await agent.run("call leaky");
  const msg = agent.getTranscript().find((m) => m.role === "tool" && m.name === "leaky");
  assert.match(msg!.content, /token=sk-\*\*\* rest/, "afterTool redacted the result");
  assert.doesNotMatch(msg!.content, /SECRET/, "secret removed");
}

// 3. Oscillation guard blocks the exact same failing call after `limit` fails.
{
  let attempts = 0;
  const flaky = makeTool("flaky", async () => {
    attempts++;
    return { content: "boom", isError: true };
  });
  const provider = new ScriptProvider();
  // The model stubbornly retries the identical call 5 times.
  provider.queue = Array.from({ length: 5 }, (_v, i) => ({
    text: "",
    toolCalls: [{ id: `r${i}`, name: "flaky", arguments: { x: 1 } }],
  }));
  provider.queue.push({ text: "giving up", toolCalls: [] });

  const agent = new Agent({
    provider,
    tools: [flaky],
    workspaceRoot: os.tmpdir(),
    approvalPolicy: "auto",
    systemPrompt: "s",
    guardrails: [createOscillationGuard({ limit: 3 })],
    maxTurns: 10,
  });
  await agent.run("keep trying");

  // limit=3 means the tool actually runs 3 times, then the 4th+ are blocked.
  assert.equal(attempts, 3, "tool ran exactly `limit` times before being blocked");
  const blocked = agent
    .getTranscript()
    .filter((m) => m.role === "tool" && m.name === "flaky" && /Blocked by guardrail "oscillation"/.test(m.content));
  assert.ok(blocked.length >= 1, "oscillation guard eventually blocked the repeat");
}

// 4. A success clears the streak (guard is stateful across calls).
{
  const guard = createOscillationGuard({ limit: 2 });
  const fail = { id: "a", name: "t", arguments: { k: 1 } };
  // Two failures reach the limit.
  assert.deepEqual(await guard.beforeTool!(fail as never, {} as never), { allow: true });
  await guard.afterTool!(fail as never, { content: "e", isError: true });
  await guard.afterTool!(fail as never, { content: "e", isError: true });
  const verdict = await guard.beforeTool!(fail as never, {} as never);
  assert.equal(verdict.allow, false, "blocked at limit");
  // A success on the same key clears it.
  await guard.afterTool!(fail as never, { content: "ok" });
  assert.deepEqual(
    await guard.beforeTool!(fail as never, {} as never),
    { allow: true },
    "success cleared the streak",
  );
}

// 5. Built-in TDD guard: blocks source edits until a test is touched; reset()
//    restores the initial state.
{
  const g = createTddGuard();
  const gctx = {} as GuardContext; // the tdd guard ignores gctx
  const srcCall = { id: "1", name: "write_file", arguments: { path: "src/foo.ts" } };
  const testCall = { id: "2", name: "write_file", arguments: { path: "src/foo.test.ts" } };

  const blockedFirst = await g.beforeTool!(srcCall as never, gctx);
  assert.equal(blockedFirst.allow, false, "source blocked before any test");
  assert.ok(!blockedFirst.allow && /TDD mode is on/.test(blockedFirst.result!.content));
  assert.ok(!blockedFirst.allow && blockedFirst.result!.isError === true);

  const testOk = await g.beforeTool!(testCall as never, gctx);
  assert.equal(testOk.allow, true, "editing a test file is allowed and records the touch");

  const srcOk = await g.beforeTool!(srcCall as never, gctx);
  assert.equal(srcOk.allow, true, "source allowed once a test exists");

  g.reset!();
  const blockedAgain = await g.beforeTool!(srcCall as never, gctx);
  assert.equal(blockedAgain.allow, false, "reset() clears the test-touched state");
}

// 6. Built-in approval guard: rejects/approves per policy, remembers "always",
//    and reset() forgets it. Non-mutating tools pass through.
{
  const g = createApprovalGuard();
  const mutTool: Tool = {
    name: "write_thing",
    description: "",
    parameters: { type: "object", properties: {} },
    mutating: true,
    run: async () => ({ content: "ok" }),
  };
  const readTool: Tool = {
    name: "read_thing",
    description: "",
    parameters: { type: "object", properties: {} },
    run: async () => ({ content: "ok" }),
  };
  const base = {
    preview: { summary: "do it" },
    ctx: { workspaceRoot: os.tmpdir() },
    policy: "confirm-each" as const,
  };
  const call = { id: "1", name: "write_thing", arguments: {} };

  // Non-mutating tool: allowed without asking.
  const readVerdict = await g.beforeTool!(
    { id: "r", name: "read_thing", arguments: {} } as never,
    { ...base, tool: readTool, requestApproval: async () => "reject" } as GuardContext,
  );
  assert.equal(readVerdict.allow, true, "non-mutating tool skips approval");

  // Reject -> blocked with a non-error, retry-discouraging message.
  const rejected = await g.beforeTool!(call as never, {
    ...base,
    tool: mutTool,
    requestApproval: async () => "reject",
  } as GuardContext);
  assert.equal(rejected.allow, false);
  assert.ok(!rejected.allow && /User rejected this action/.test(rejected.result!.content));
  assert.ok(!rejected.allow && rejected.result!.isError === false, "rejection is not an error");

  // Approve "always" -> allowed, and remembered so later calls don't re-prompt.
  const approvedAlways = await g.beforeTool!(call as never, {
    ...base,
    tool: mutTool,
    requestApproval: async () => "always",
  } as GuardContext);
  assert.equal(approvedAlways.allow, true);

  let asked = false;
  const remembered = await g.beforeTool!(call as never, {
    ...base,
    tool: mutTool,
    requestApproval: async () => {
      asked = true;
      return "reject";
    },
  } as GuardContext);
  assert.equal(remembered.allow, true, "always-approved tool not re-prompted");
  assert.equal(asked, false, "requestApproval not called after always");

  // reset() forgets the "always" grant.
  g.reset!();
  const afterReset = await g.beforeTool!(call as never, {
    ...base,
    tool: mutTool,
    requestApproval: async () => "reject",
  } as GuardContext);
  assert.equal(afterReset.allow, false, "reset() clears remembered approvals");
}

// 7. End-to-end through the Agent: TDD + approval are active via options.
{
  const provider = new ScriptProvider();
  provider.queue = [
    // First tries to edit source (blocked by TDD), then writes a test, then source.
    { text: "", toolCalls: [{ id: "a", name: "write_file", arguments: { path: "src/x.ts", content: "1" } }] },
    { text: "", toolCalls: [{ id: "b", name: "write_file", arguments: { path: "src/x.test.ts", content: "t" } }] },
    { text: "", toolCalls: [{ id: "c", name: "write_file", arguments: { path: "src/x.ts", content: "impl" } }] },
    { text: "done", toolCalls: [] },
  ];
  const writeTool: Tool = {
    name: "write_file",
    description: "",
    parameters: { type: "object", properties: {} },
    mutating: true,
    run: async () => ({ content: "wrote" }),
  };
  const agent = new Agent({
    provider,
    tools: [writeTool],
    workspaceRoot: os.tmpdir(),
    approvalPolicy: "auto",
    systemPrompt: "s",
    tddMode: true,
  });
  await agent.run("build x");
  const results = agent.getTranscript().filter((m) => m.role === "tool");
  assert.match(results[0]!.content, /TDD mode is on/, "first source edit blocked by TDD guard");
  assert.match(results[1]!.content, /wrote/, "test write allowed");
  assert.match(results[2]!.content, /wrote/, "source write allowed after test");
}

process.stdout.write("test-guardrails: ALL PASS\n");
