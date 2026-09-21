/**
 * Deterministic test: sub-agents (spawn_subagent / handoff).
 * Covers: the parent delegates a task to a child agent that runs in the same
 * workspace with its own clean context, the child's file edits persist, only the
 * child's summary is returned to the parent, callbacks fire, and the depth guard
 * blocks a child from spawning further sub-agents. No network.
 *
 * Run: node --import tsx scripts/test-subagent.mts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Agent,
  readFileTool,
  spawnSubagentTool,
  spawnSubagentsTool,
  writeFileTool,
  type ChatParams,
  type ChatResult,
  type LLMProvider,
} from "@scissor/core";

/** Provider that plays back a queue of scripted responses (shared parent+child). */
class ScriptProvider implements LLMProvider {
  id = "deepseek" as const;
  model = "script";
  queue: ChatResult[] = [];
  async chat(_p: ChatParams): Promise<ChatResult> {
    return this.queue.shift() ?? { text: "done", toolCalls: [] };
  }
}

// 1. Parent delegates; child writes a file; summary comes back to the parent.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-subagent-"));
  const provider = new ScriptProvider();
  provider.queue = [
    // parent turn 1: delegate
    {
      text: "",
      toolCalls: [
        { id: "p1", name: "spawn_subagent", arguments: { task: "create foo.txt containing hello" } },
      ],
    },
    // child turn 1: write the file
    {
      text: "",
      toolCalls: [
        { id: "c1", name: "write_file", arguments: { path: "foo.txt", content: "hello from subagent" } },
      ],
    },
    // child turn 2: summarize
    { text: "SUBAGENT SUMMARY: created foo.txt", toolCalls: [] },
    // parent turn 2: finish
    { text: "Delegated and done.", toolCalls: [] },
  ];

  const starts: Array<{ task: string; depth: number }> = [];
  const ends: Array<{ depth: number }> = [];
  const agent = new Agent({
    provider,
    tools: [spawnSubagentTool, writeFileTool, readFileTool],
    workspaceRoot: dir,
    approvalPolicy: "auto",
    systemPrompt: "BASE",
  });

  const res = await agent.run("please create foo.txt", {
    onRequestApproval: async () => "approve",
    onSubagentStart: (task, depth) => starts.push({ task, depth }),
    onSubagentEnd: (_summary, depth) => ends.push({ depth }),
  });

  // The child's edit persisted in the shared workspace.
  const written = await fs.readFile(path.join(dir, "foo.txt"), "utf8");
  assert.equal(written, "hello from subagent", "child edit persisted");

  // The parent transcript has a spawn_subagent tool result carrying the summary.
  const toolMsg = agent.getTranscript().find((m) => m.role === "tool" && m.name === "spawn_subagent");
  assert.ok(toolMsg, "spawn_subagent tool result present");
  assert.match(toolMsg!.content, /SUBAGENT SUMMARY: created foo\.txt/, "summary returned to parent");
  assert.match(toolMsg!.content, /Sub-agent finished \(2 turns\)/, "reports child turns");

  // Callbacks fired at depth 1.
  assert.deepEqual(starts, [{ task: "create foo.txt containing hello", depth: 1 }]);
  assert.deepEqual(ends, [{ depth: 1 }]);

  assert.equal(res.finalText, "Delegated and done.");
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// 2. Depth guard: a child (subagentDepth == maxSubagentDepth) cannot spawn.
{
  const provider = new ScriptProvider();
  provider.queue = [
    {
      text: "",
      toolCalls: [
        { id: "x1", name: "spawn_subagent", arguments: { task: "try to nest" } },
      ],
    },
    { text: "cannot nest, did it myself", toolCalls: [] },
  ];
  const child = new Agent({
    provider,
    tools: [spawnSubagentTool, writeFileTool],
    workspaceRoot: os.tmpdir(),
    approvalPolicy: "auto",
    systemPrompt: "BASE",
    subagentDepth: 1,
    maxSubagentDepth: 1,
  });
  await child.run("do a nested thing");
  const toolMsg = child.getTranscript().find((m) => m.role === "tool" && m.name === "spawn_subagent");
  assert.ok(toolMsg, "spawn attempt recorded");
  assert.match(toolMsg!.content, /cannot spawn further sub-agents/, "depth guard blocks nesting");
}

// 3. Missing task is rejected.
{
  const provider = new ScriptProvider();
  provider.queue = [
    { text: "", toolCalls: [{ id: "e1", name: "spawn_subagent", arguments: {} }] },
    { text: "ok", toolCalls: [] },
  ];
  const agent = new Agent({
    provider,
    tools: [spawnSubagentTool],
    workspaceRoot: os.tmpdir(),
    approvalPolicy: "auto",
    systemPrompt: "BASE",
  });
  await agent.run("delegate nothing");
  const toolMsg = agent.getTranscript().find((m) => m.role === "tool" && m.name === "spawn_subagent");
  assert.match(toolMsg!.content, /'task' is required/, "empty task rejected");
}

// 4. Parallel fan-out: two independent sub-agents run concurrently, both edits
//    persist, and the aggregated summary carries both results.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-subagents-"));

  // Stateless, content-routed provider so concurrent children stay deterministic
  // regardless of scheduling order (a shared FIFO queue would race).
  class RoutingProvider implements LLMProvider {
    id = "deepseek" as const;
    model = "script";
    async chat(p: ChatParams): Promise<ChatResult> {
      const firstUser = String(p.messages.find((m) => m.role === "user")?.content ?? "");
      const hasToolResult = p.messages.some((m) => m.role === "tool");
      if (firstUser.includes("PARENT")) {
        return hasToolResult
          ? { text: "parent done", toolCalls: [] }
          : {
              text: "",
              toolCalls: [
                {
                  id: "p",
                  name: "spawn_subagents",
                  arguments: { tasks: ["TASK_A: write a.txt", "TASK_B: write b.txt"] },
                },
              ],
            };
      }
      if (firstUser.includes("TASK_A")) {
        return hasToolResult
          ? { text: "SUMMARY A done", toolCalls: [] }
          : { text: "", toolCalls: [{ id: "ca", name: "write_file", arguments: { path: "a.txt", content: "AAA" } }] };
      }
      if (firstUser.includes("TASK_B")) {
        return hasToolResult
          ? { text: "SUMMARY B done", toolCalls: [] }
          : { text: "", toolCalls: [{ id: "cb", name: "write_file", arguments: { path: "b.txt", content: "BBB" } }] };
      }
      return { text: "done", toolCalls: [] };
    }
  }

  const starts: number[] = [];
  const agent = new Agent({
    provider: new RoutingProvider(),
    tools: [spawnSubagentsTool, writeFileTool, readFileTool],
    workspaceRoot: dir,
    approvalPolicy: "auto",
    systemPrompt: "BASE",
  });
  const res = await agent.run("PARENT: split the work", {
    onSubagentStart: (_task, depth) => starts.push(depth),
  });

  assert.equal(await fs.readFile(path.join(dir, "a.txt"), "utf8"), "AAA", "child A edit persisted");
  assert.equal(await fs.readFile(path.join(dir, "b.txt"), "utf8"), "BBB", "child B edit persisted");

  const toolMsg = agent.getTranscript().find((m) => m.role === "tool" && m.name === "spawn_subagents");
  assert.ok(toolMsg, "spawn_subagents tool result present");
  assert.match(toolMsg!.content, /2\/2 succeeded/, "aggregated header");
  assert.match(toolMsg!.content, /SUMMARY A done/, "child A summary aggregated");
  assert.match(toolMsg!.content, /SUMMARY B done/, "child B summary aggregated");
  assert.equal(starts.length, 2, "two sub-agents started");
  assert.ok(starts.every((d) => d === 1), "both at depth 1");
  assert.equal(res.finalText, "parent done");
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// 5. spawn_subagents needs >= 2 tasks.
{
  const provider = new ScriptProvider();
  provider.queue = [
    { text: "", toolCalls: [{ id: "s1", name: "spawn_subagents", arguments: { tasks: ["only one"] } }] },
    { text: "ok", toolCalls: [] },
  ];
  const agent = new Agent({
    provider,
    tools: [spawnSubagentsTool],
    workspaceRoot: os.tmpdir(),
    approvalPolicy: "auto",
    systemPrompt: "BASE",
  });
  await agent.run("fan out one");
  const toolMsg = agent.getTranscript().find((m) => m.role === "tool" && m.name === "spawn_subagents");
  assert.match(toolMsg!.content, /at least 2 tasks/, "single-task fan-out rejected");
}

// 6. Depth guard applies to parallel fan-out too.
{
  const provider = new ScriptProvider();
  provider.queue = [
    { text: "", toolCalls: [{ id: "s1", name: "spawn_subagents", arguments: { tasks: ["a", "b"] } }] },
    { text: "did it myself", toolCalls: [] },
  ];
  const child = new Agent({
    provider,
    tools: [spawnSubagentsTool],
    workspaceRoot: os.tmpdir(),
    approvalPolicy: "auto",
    systemPrompt: "BASE",
    subagentDepth: 1,
    maxSubagentDepth: 1,
  });
  await child.run("nested fan-out");
  const toolMsg = child.getTranscript().find((m) => m.role === "tool" && m.name === "spawn_subagents");
  assert.match(toolMsg!.content, /cannot spawn further sub-agents/, "depth guard blocks parallel nesting");
}

process.stdout.write("test-subagent: ALL PASS\n");
