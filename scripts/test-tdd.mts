/**
 * Deterministic test for the test-first (TDD) hard gate. A scripted provider
 * first tries to edit source (must be blocked), then writes a test file (the
 * gate opens), then edits source (now allowed). Also checks the path
 * classification helpers. No network.
 *
 * Run: node --import tsx scripts/test-tdd.mts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Agent,
  defaultTools,
  isSourceFile,
  isTestFile,
  type ChatParams,
  type ChatResult,
  type LLMProvider,
} from "@scissor/core";

// --- path classification ---
assert.equal(isTestFile("src/sum.test.ts"), true);
assert.equal(isTestFile("tests/thing.py"), true);
assert.equal(isTestFile("pkg/foo_test.go"), true);
assert.equal(isTestFile("__tests__/a.js"), true);
assert.equal(isTestFile("src/sum.ts"), false);
assert.equal(isSourceFile("src/sum.ts"), true);
assert.equal(isSourceFile("src/sum.test.ts"), false, "test files are not source-gated");
assert.equal(isSourceFile("README.md"), false, "docs are not gated");
assert.equal(isSourceFile("package.json"), false, "config is not gated");

// A provider scripted to: (1) try editing source first, (2) write a test,
// (3) write the source. The agent decides whether each write is allowed.
class TddProvider implements LLMProvider {
  id = "deepseek" as const;
  model = "scripted";
  private i = 0;
  async chat(_p: ChatParams): Promise<ChatResult> {
    this.i++;
    if (this.i === 1) {
      return {
        text: "",
        toolCalls: [
          { id: "a", name: "write_file", arguments: { path: "sum.js", content: "module.exports.sum=(a,b)=>a+b;\n" } },
        ],
      };
    }
    if (this.i === 2) {
      return {
        text: "",
        toolCalls: [
          { id: "b", name: "write_file", arguments: { path: "sum.test.js", content: "// test\n" } },
        ],
      };
    }
    if (this.i === 3) {
      return {
        text: "",
        toolCalls: [
          { id: "c", name: "write_file", arguments: { path: "sum.js", content: "module.exports.sum=(a,b)=>a+b;\n" } },
        ],
      };
    }
    return { text: "done", toolCalls: [] };
  }
}

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-tdd-test-"));

const agent = new Agent({
  provider: new TddProvider(),
  tools: defaultTools(),
  workspaceRoot: workspace,
  approvalPolicy: "auto",
  systemPrompt: "test",
  tddMode: true,
});

try {
  await agent.run("build sum");

  // Tool result messages, in order: [blocked source, test created, source created].
  const toolMsgs = agent.getTranscript().filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 3, `expected 3 tool results, got ${toolMsgs.length}`);
  assert.match(toolMsgs[0]!.content, /TDD mode is on/, "source before test is blocked with guidance");
  assert.match(toolMsgs[1]!.content, /sum\.test\.js/, "test file write allowed");
  assert.match(toolMsgs[2]!.content, /sum\.js/, "source write allowed after a test exists");
  assert.doesNotMatch(toolMsgs[2]!.content, /TDD mode is on/, "second source write not blocked");

  // The blocked write must not have created the file until the allowed write.
  const wrote = await fs
    .readFile(path.join(workspace, "sum.js"), "utf8")
    .then(() => true)
    .catch(() => false);
  assert.equal(wrote, true, "source exists after the allowed write");
} finally {
  await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
}

// --- gate is off by default (no tddMode) ---
{
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-tdd-off-"));
  class Once implements LLMProvider {
    id = "deepseek" as const;
    model = "scripted";
    private n = 0;
    async chat(): Promise<ChatResult> {
      this.n++;
      if (this.n === 1) {
        return { text: "", toolCalls: [{ id: "x", name: "write_file", arguments: { path: "a.js", content: "1\n" } }] };
      }
      return { text: "done", toolCalls: [] };
    }
  }
  const a = new Agent({
    provider: new Once(),
    tools: defaultTools(),
    workspaceRoot: ws,
    approvalPolicy: "auto",
    systemPrompt: "t",
  });
  await a.run("x");
  const toolMsgs = a.getTranscript().filter((m) => m.role === "tool");
  assert.doesNotMatch(toolMsgs[0]!.content, /TDD mode is on/, "without tddMode, source writes are not gated");
  await fs.rm(ws, { recursive: true, force: true }).catch(() => {});
}

process.stdout.write("\x1b[32mtest-tdd: ALL PASS\x1b[0m\n");
