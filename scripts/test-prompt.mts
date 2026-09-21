/**
 * Deterministic test: the sectioned system prompt and the generated tool
 * inventory.
 *
 * The regression this locks down: the tool list used to be hand-written in the
 * prompt and had drifted — it advertised 9 tools while the real default set had
 * 14, so the agent was never told about diagnostics, remember, update_scratchpad
 * or the sub-agent tools. It is now generated from the tool set, and this test
 * asserts the two agree. No network.
 *
 * Run: node --import tsx scripts/test-prompt.mts
 */
import assert from "node:assert/strict";
import os from "node:os";
import {
  Agent,
  buildSystemPrompt,
  defaultTools,
  renderToolInventory,
  section,
  type ChatParams,
  type ChatResult,
  type LLMProvider,
  type Tool,
} from "@scissor/core";

class ScriptProvider implements LLMProvider {
  id = "deepseek" as const;
  model = "script";
  async chat(_p: ChatParams): Promise<ChatResult> {
    return { text: "done", toolCalls: [] };
  }
}

// ------------------------------------------------------------------- sections

{
  assert.equal(section("env", "body"), "<env>\nbody\n</env>");
  assert.equal(section("env", "  padded  "), "<env>\npadded\n</env>", "body is trimmed");
}

const tools = defaultTools({ selfEdit: false });
const prompt = buildSystemPrompt({
  workspaceRoot: "/ws",
  platform: "linux",
  approvalPolicy: "plan-gate",
  tools,
});

for (const tag of ["identity", "environment", "tools", "working_principles"]) {
  assert.match(prompt, new RegExp(`<${tag}>`), `<${tag}> section present`);
  assert.match(prompt, new RegExp(`</${tag}>`), `<${tag}> section closed`);
}
assert.match(prompt, /Operating system: linux/);
assert.match(prompt, /Workspace root[^\n]*\/ws/);
assert.match(prompt, /Approval policy: plan-gate/);

// Conditional sections are absent unless asked for.
for (const tag of ["clarification", "tdd_mode", "self_edit_mode", "repo_map", "memory", "experience"]) {
  assert.doesNotMatch(prompt, new RegExp(`<${tag}>`), `<${tag}> omitted by default`);
}

// ...and present when they are.
{
  const full = buildSystemPrompt({
    workspaceRoot: "/ws",
    platform: "linux",
    approvalPolicy: "auto",
    tools,
    clarify: true,
    tdd: true,
    selfEdit: true,
    repoMap: "src/\n  a.ts",
    memory: "the user prefers tabs",
    experienceAdvice: "read_file has been reliable here",
  });
  for (const tag of ["clarification", "tdd_mode", "self_edit_mode", "repo_map", "memory", "experience"]) {
    assert.match(full, new RegExp(`<${tag}>`), `<${tag}> included when provided`);
  }
  assert.match(full, /the user prefers tabs/);
  assert.match(full, /src\/\n\s+a\.ts/);
}

// ------------------------------------------------------- the tool inventory

{
  // Every real tool is advertised. This is the drift the hand-written list had.
  for (const tool of tools) {
    assert.match(prompt, new RegExp(`- ${tool.name}:`), `${tool.name} is listed`);
  }

  // Specifically the ones the old hand-written list forgot.
  for (const name of [
    "diagnostics",
    "remember",
    "update_scratchpad",
    "todo_write",
    "await_shell",
    "spawn_subagent",
    "spawn_subagents",
  ]) {
    assert.match(prompt, new RegExp(`- ${name}:`), `${name} is listed`);
    assert.ok(
      tools.some((t) => t.name === name),
      `${name} really is in the default tool set`,
    );
  }

  // And nothing is advertised that does not exist.
  const advertised = [...prompt.matchAll(/^- (\w+):/gm)].map((m) => m[1]!);
  const real = new Set(tools.map((t) => t.name));
  for (const name of advertised) {
    assert.ok(real.has(name), `advertised tool "${name}" exists in the tool set`);
  }
  assert.equal(advertised.length, tools.length, "the counts agree");
}

{
  // The inventory stays terse: one line per tool, first sentence only.
  const verbose: Tool = {
    name: "verbose",
    description:
      "Does the first thing. Then it does a second thing that should not appear. " +
      "And a third.",
    parameters: { type: "object", properties: {} },
    async run() {
      return { content: "" };
    },
  };
  const inventory = renderToolInventory([verbose]);
  assert.match(inventory, /- verbose: Does the first thing\./);
  assert.doesNotMatch(inventory, /second thing/, "later sentences are dropped");
  assert.equal(
    inventory.split("\n").filter((l) => l.startsWith("- ")).length,
    1,
    "one line per tool",
  );

  // A very long first sentence is capped.
  const rambling: Tool = {
    ...verbose,
    name: "rambling",
    description: "A" + " word".repeat(200) + ".",
  };
  const line = renderToolInventory([rambling]).split("\n").find((l) => l.startsWith("- "))!;
  assert.ok(line.length < 200, `long descriptions are capped (${line.length} chars)`);
  assert.ok(line.endsWith("…"), "and marked as elided");
}

assert.match(renderToolInventory([]), /No tools are available/, "the empty case reads sensibly");

// --------------------------------------------------- through the Agent default

{
  // An Agent that builds its own prompt advertises exactly its own tools.
  const subset = tools.filter((t) => ["read_file", "run_shell"].includes(t.name));
  const agent = new Agent({
    provider: new ScriptProvider(),
    tools: subset,
    workspaceRoot: os.tmpdir(),
    approvalPolicy: "auto",
  });
  const sys = agent.getMessages()[0]!.content;
  assert.match(sys, /- read_file:/);
  assert.match(sys, /- run_shell:/);
  assert.doesNotMatch(sys, /- edit_file:/, "a tool this agent lacks is not advertised");
}

process.stdout.write("test-prompt: ALL PASS\n");
