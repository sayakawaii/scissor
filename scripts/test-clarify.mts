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
import { buildSystemPrompt, loadConfig } from "@scissor/core";

const base = {
  workspaceRoot: "/tmp/ws",
  platform: "linux",
  approvalPolicy: "plan-gate" as const,
};

// --- prompt gating ---
const off = buildSystemPrompt(base);
assert.ok(!/INTENT CLARIFICATION is ENABLED/.test(off), "no clarify block when disabled");

const on = buildSystemPrompt({ ...base, clarify: true });
assert.match(on, /INTENT CLARIFICATION is ENABLED/, "clarify block present when enabled");
assert.match(on, /ask_user/, "clarify guidance references ask_user");
assert.match(on, /2-3 concrete interpretations/, "clarify guidance offers 2-3 options");
assert.match(on, /Do NOT clarify when the request is already specific/, "guards against over-asking");

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

process.stdout.write("\x1b[32mtest-clarify: ALL PASS\x1b[0m\n");
