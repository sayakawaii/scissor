/**
 * Real-LLM smoke: the model edits a CRLF file. Models almost always emit LF
 * old_string, so this exercises the edit engine's line-ending tolerance in a
 * live session. Requires a provider key.
 *
 * Run: node --import tsx scripts/smoke-edit.mts
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSession } from "../packages/cli/src/session.js";

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-edit-"));
const file = path.join(workspace, "greet.js");
// Deliberately CRLF line endings.
const original = ["function greet(name) {", "  return \"hello \" + name;", "}", ""].join("\r\n");
await fs.writeFile(file, original, "utf8");

const session = await createSession({ workspaceRoot: workspace, approvalPolicy: "auto" });

let editErrored = false;
await session.agent.run(
  'In greet.js, change the greeting word from "hello" to "hi there" (keep everything else identical).',
  {
    onAssistantText: (d) => process.stdout.write(d),
    onToolStart: (c, p) => process.stdout.write(`\n[tool] ${c.name} ${p?.summary ?? ""}\n`),
    onToolEnd: (c, r) => {
      if (r.isError && c.name === "edit_file") editErrored = true;
      process.stdout.write(`[${r.isError ? "err" : "ok"}] ${c.name}: ${r.content}\n`);
    },
    onRequestApproval: async () => "approve",
    onPresentPlan: async () => ({ action: "approve" }),
    onAskUser: async () => "proceed",
    onVerifyStart: () => process.stdout.write("\n[verify] running...\n"),
    onVerifyResult: (r) => process.stdout.write(`[verify] ${r.ok ? "OK" : "FAIL"}\n`),
  },
);

const updated = await fs.readFile(file, "utf8");
const changed = updated.includes("hi there") && !updated.includes("hello");
const keptCrlf = updated.includes("\r\n");
const valid = /function greet/.test(updated);

process.stdout.write("\n");
process.stdout.write(`edit succeeded:   ${!editErrored ? "PASS" : "FAIL"}\n`);
process.stdout.write(`text changed:     ${changed ? "PASS" : "FAIL"}\n`);
process.stdout.write(`kept CRLF eol:    ${keptCrlf ? "PASS" : "FAIL"}\n`);
process.stdout.write(`still valid code: ${valid ? "PASS" : "FAIL"}\n`);

await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
if (editErrored || !changed || !keptCrlf || !valid) process.exit(1);
process.stdout.write("\x1b[32msmoke-edit: ALL PASS\x1b[0m\n");
