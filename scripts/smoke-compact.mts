/**
 * Real-LLM smoke: the default (provider-backed) summarizer actually compacts a
 * growing conversation, and the most recent round survives. Requires a key.
 *
 * Run: node --import tsx scripts/smoke-compact.mts
 */
import os from "node:os";
import {
  Agent,
  applyEnvOverrides,
  createProvider,
  loadConfig,
} from "@scissor/core";

const config = applyEnvOverrides(await loadConfig());
const provider = createProvider(config, config.defaultProvider);

const agent = new Agent({
  provider,
  tools: [],
  workspaceRoot: os.tmpdir(),
  approvalPolicy: "auto",
  systemPrompt: "You are a terse assistant. Answer in one short sentence.",
  maxContextChars: 550,
});

let compacted = false;
const cb = {
  onCompact: (i: { summarizedMessages: number; beforeChars: number; afterChars: number }) => {
    compacted = true;
    process.stdout.write(
      `\n[compact] folded ${i.summarizedMessages} msgs, ${i.beforeChars} -> ${i.afterChars} chars\n`,
    );
  },
};

const prompts = [
  "My project is called Nimbus and it is a weather app written in Rust. Remember that.",
  "The main file is src/main.rs and I use the reqwest crate for HTTP. Note it.",
  "I deploy to Fly.io in the region iad. Keep that in mind.",
  "What is the name of my project, its language, and where do I deploy it?",
];

let lastAnswer = "";
for (const p of prompts) {
  const r = await agent.run(p, cb);
  lastAnswer = r.finalText;
  process.stdout.write(`\nQ: ${p}\nA: ${r.finalText}\n`);
}

const transcript = agent.getTranscript().map((m) => `${m.role}:${m.content}`).join("\n");
const hasSummary = transcript.includes("[Summary of earlier conversation]");
const recentKept = transcript.includes("What is the name of my project");
// The model should still recall facts from the summarized early rounds.
const recalled = /nimbus/i.test(lastAnswer);

process.stdout.write("\n");
process.stdout.write(`compaction fired:  ${compacted ? "PASS" : "FAIL"}\n`);
process.stdout.write(`summary inserted:  ${hasSummary ? "PASS" : "FAIL"}\n`);
process.stdout.write(`recent round kept: ${recentKept ? "PASS" : "FAIL"}\n`);
process.stdout.write(`recalled via summary: ${recalled ? "PASS" : "WARN (model-dependent)"}\n`);

if (!compacted || !hasSummary || !recentKept) process.exit(1);
process.stdout.write("\x1b[32msmoke-compact: ALL PASS\x1b[0m\n");
