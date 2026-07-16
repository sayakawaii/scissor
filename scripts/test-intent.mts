/**
 * Deterministic test: the vagueness heuristic behind auto intent-clarification.
 * Precision-biased — specific requests must never be flagged. No network.
 *
 * Run: node --import tsx scripts/test-intent.mts
 */
import assert from "node:assert/strict";
import { isVagueRequest } from "@scissor/core";

// --- clearly vague → should clarify ---
const vague = [
  "fix it",
  "improve this",
  "optimize it",
  "make it better",
  "clean up the code",
  "refactor this stuff",
  "help me",
  "can you improve the app?",
  "优化一下",
  "帮我改一下这个",
  "看看这段代码",
  "重构一下",
];
for (const q of vague) {
  assert.ok(isVagueRequest(q), `should flag as vague: "${q}"`);
}

// --- specific enough → must NOT clarify ---
const specific = [
  "fix the null check in auth.ts",
  "add a retry helper with exponential backoff to src/net.ts",
  "rename getCwd to getCurrentWorkingDirectory",
  "improve the performance of parseConfig by memoizing results",
  "write a CLI that converts JSON to CSV",
  "explain how the router picks a model tier",
  "在 repo-index.ts 里给 retrieve 加上模糊匹配",
  "把 README 里的 Memory model 一节翻译成英文",
  "update package.json to bump the version to 0.3.0",
  "",
  "   ",
];
for (const q of specific) {
  assert.ok(!isVagueRequest(q), `should NOT flag as vague: "${q}"`);
}

// A long, detailed prompt is never gated even with a vague verb.
assert.ok(
  !isVagueRequest(
    "improve the retrieval so that when the user query has typos we still find the file, " +
      "by tokenizing and merging several phrasings before ranking",
  ),
  "long detailed prompt is not vague",
);

process.stdout.write("\x1b[32mtest-intent: ALL PASS\x1b[0m\n");
