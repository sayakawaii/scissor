/**
 * Deterministic test: session save/load round-trip + agent resume.
 * No network required.
 *
 * Run: node --import tsx scripts/test-session.mts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-sess-"));
process.env.SCISSOR_CONFIG_DIR = tmp;

const {
  Agent,
  saveSession,
  loadSession,
  listSessions,
  newSessionId,
} = await import("@scissor/core");
type SessionData = import("@scissor/core").SessionData;
type LLMProvider = import("@scissor/core").LLMProvider;
type Message = import("@scissor/core").Message;

const dummyProvider: LLMProvider = {
  id: "deepseek",
  model: "test",
  async chat() {
    return { text: "", toolCalls: [] };
  },
};

const messages: Message[] = [
  { role: "user", content: "remember my name is Ming" },
  { role: "assistant", content: "Got it, Ming." },
  { role: "user", content: "what's my name?" },
  { role: "assistant", content: "Your name is Ming." },
];

const data: SessionData = {
  formatVersion: 1,
  id: newSessionId(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  provider: "deepseek",
  model: "deepseek-chat",
  workspaceRoot: tmp,
  approvalPolicy: "plan-gate",
  goal: "test goal",
  generation: 2,
  lastCheckpoint: "abc123",
  messages,
};

await saveSession(data);
const loaded = await loadSession(data.id);
assert.equal(loaded.messages.length, 4, "message count preserved");
assert.equal(loaded.goal, "test goal");
assert.equal(loaded.generation, 2);
assert.equal(loaded.lastCheckpoint, "abc123");
assert.deepEqual(loaded.messages, messages, "messages round-trip exactly");

const sessions = await listSessions();
assert.ok(
  sessions.some((s) => s.id === data.id),
  "session appears in listSessions",
);

// Resume into a fresh Agent and confirm the transcript is restored.
const agent = new Agent({
  provider: dummyProvider,
  tools: [],
  workspaceRoot: tmp,
  initialMessages: loaded.messages,
});
const transcript = agent.getTranscript();
assert.deepEqual(transcript, messages, "agent resumes transcript (excluding system)");

// The system prompt must not leak into the persisted transcript.
assert.ok(
  !transcript.some((m) => m.role === "system"),
  "transcript excludes system prompt",
);

await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
process.stdout.write("\x1b[32mtest-session: ALL PASS\x1b[0m\n");
