/**
 * Deterministic test: intent-clarification gate wiring.
 * Covers: buildSystemPrompt injects the clarify directive only when enabled,
 * and config.clarifyIntent round-trips through loadConfig. No network.
 *
 * Run: node --import tsx scripts/test-clarify.mts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Agent,
  buildSystemPrompt,
  loadConfig,
  type ChatParams,
  type ChatResult,
  type LLMProvider,
} from "@scissor/core";

const base = {
  workspaceRoot: "/tmp/ws",
  platform: "linux",
  approvalPolicy: "plan-gate" as const,
};

// --- prompt gating ---
const off = buildSystemPrompt(base);
assert.ok(!/INTENT CLARIFICATION/.test(off), "no clarify block when disabled");

const on = buildSystemPrompt({ ...base, clarify: true });
assert.match(on, /INTENT CLARIFICATION/, "clarify block present when enabled");
assert.match(on, /ask_user/, "clarify guidance references ask_user");
assert.match(on, /2-3 concrete interpretations/, "clarify guidance offers 2-3 options");
assert.match(on, /Ask at most one round/, "guards against over-asking");

// --- config round-trip ---
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-clarify-"));
const prev = process.env.SCISSOR_CONFIG_DIR;
process.env.SCISSOR_CONFIG_DIR = dir;
try {
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({ defaultProvider: "deepseek", providers: {}, clarifyIntent: true }),
    "utf8",
  );
  const cfg = await loadConfig();
  assert.equal(cfg.clarifyIntent, true, "clarifyIntent loaded from config");

  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({ defaultProvider: "deepseek", providers: {} }),
    "utf8",
  );
  const cfg2 = await loadConfig();
  assert.equal(cfg2.clarifyIntent, undefined, "clarifyIntent defaults off");
} finally {
  if (prev === undefined) delete process.env.SCISSOR_CONFIG_DIR;
  else process.env.SCISSOR_CONFIG_DIR = prev;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// --- auto mode: the agent injects guidance only for vague runs ---
class CaptureProvider implements LLMProvider {
  id = "deepseek" as const;
  model = "script";
  seenSystem: string[] = [];
  async chat(p: ChatParams): Promise<ChatResult> {
    const sys = p.messages.find((m) => m.role === "system");
    this.seenSystem.push(String(sys?.content ?? ""));
    return { text: "done", toolCalls: [] };
  }
}

function makeAgent(provider: CaptureProvider, autoClarify: boolean): Agent {
  return new Agent({
    provider,
    tools: [],
    workspaceRoot: process.cwd(),
    approvalPolicy: "auto",
    systemPrompt: "BASE PROMPT",
    autoClarify,
  });
}

// Vague input under autoClarify → guidance present during the run.
{
  const provider = new CaptureProvider();
  const agent = makeAgent(provider, true);
  await agent.run("fix it");
  assert.match(provider.seenSystem[0]!, /INTENT CLARIFICATION/, "vague run injects guidance");
  // Transient: after the run, the persisted system message is clean again.
  const sysAfter = agent.getMessages().find((m) => m.role === "system");
  assert.ok(!/INTENT CLARIFICATION/.test(String(sysAfter?.content)), "guidance cleared after run");
}

// Specific input under autoClarify → no guidance.
{
  const provider = new CaptureProvider();
  const agent = makeAgent(provider, true);
  await agent.run("add a retry helper to src/net.ts");
  assert.ok(!/INTENT CLARIFICATION/.test(provider.seenSystem[0]!), "specific run stays clean");
}

// autoClarify off → never injects, even for vague input.
{
  const provider = new CaptureProvider();
  const agent = makeAgent(provider, false);
  await agent.run("fix it");
  assert.ok(!/INTENT CLARIFICATION/.test(provider.seenSystem[0]!), "auto off never injects");
}

process.stdout.write("\x1b[32mtest-clarify: ALL PASS\x1b[0m\n");
