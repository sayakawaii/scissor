/**
 * Deterministic test for the zero-key replay demo.
 *
 * The demo's value depends entirely on it being what it claims: a real agent
 * run with only the model's replies scripted. So the assertions below check the
 * claim rather than the narration — the bug genuinely fails the test before the
 * run, the fix is genuinely on disk afterwards, and `node test/stats.test.js`
 * genuinely exits 0 when this test runs it independently of the agent.
 *
 * It also pins the honesty properties: the run must work with every provider
 * key removed from the environment, must not touch the user's working
 * directory, and must label itself a replay without claiming live inference.
 *
 * No network: the provider is a script.
 *
 * Run: node --import tsx scripts/test-demo.mts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ScriptedProvider, SCRIPT_EXHAUSTED_TEXT, type ChatParams } from "@scissor/core";
import { runDemo } from "../packages/cli/src/commands/demo.js";
import {
  BUGGY_MEDIAN,
  DEMO_FILES,
  DEMO_SCRIPT,
  DEMO_TASK,
  DEMO_TEST_COMMAND,
  DEMO_TOOL_SEQUENCE,
  FIXED_MEDIAN,
  seedDemoWorkspace,
} from "../packages/cli/src/demo/scenario.js";
import { exec } from "../packages/cli/src/self/repo.js";

const KEY_VARS = [
  "DEEPSEEK_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GLM_API_KEY",
  "NEBIUS_API_KEY",
  "TAVILY_API_KEY",
];

// --- 1. ScriptedProvider: a pure lookup that never does I/O -----------------
{
  const p = new ScriptedProvider({
    script: [
      { text: "one", toolCalls: [] },
      { text: "two", toolCalls: [] },
    ],
  });
  assert.equal(p.turnCount, 2);
  assert.equal(p.turnsUsed, 0);
  assert.equal(p.exhausted, false);

  const params = { messages: [], tools: [] } as unknown as ChatParams;
  assert.equal((await p.chat(params)).text, "one", "turns replay in order");
  assert.equal((await p.chat(params)).text, "two");
  assert.equal(p.exhausted, true);

  // Overrunning the script ends the loop instead of throwing or hanging.
  const past = await p.chat(params);
  assert.equal(past.text, SCRIPT_EXHAUSTED_TEXT);
  assert.deepEqual(past.toolCalls, []);

  assert.equal(p.calls.length, 3, "every request is recorded for inspection");
  // The reported model must not be mistakable for a real one.
  assert.equal(p.model, "scripted-replay");
}

// --- 2. The seeded bug is real: the test fails before the agent touches it ---
const probe = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-demo-probe-"));
try {
  await seedDemoWorkspace(probe);
  for (const rel of Object.keys(DEMO_FILES)) {
    await fs.access(path.join(probe, rel));
  }
  const before = await exec("node", ["test/stats.test.js"], probe, 30_000);
  assert.equal(before.ok, false, "the seeded workspace must genuinely fail its test");
  assert.match(
    before.stderr,
    /even-length/,
    "it must fail on the median assertion, not on something incidental",
  );

  const src = await fs.readFile(path.join(probe, "src/stats.js"), "utf8");
  assert.ok(src.includes(BUGGY_MEDIAN), "the workspace starts from the buggy implementation");
} finally {
  await fs.rm(probe, { recursive: true, force: true }).catch(() => {});
}

// --- 3. The demo runs with no credentials whatsoever ------------------------
const savedKeys: Record<string, string | undefined> = {};
for (const k of KEY_VARS) {
  savedKeys[k] = process.env[k];
  delete process.env[k];
}

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-demo-test-"));
const captured: string[] = [];
const cwdBefore = process.cwd();
const cwdEntriesBefore = new Set(await fs.readdir(cwdBefore));

let result;
try {
  result = await runDemo({ dir: workspace, out: (s) => captured.push(s) });
} finally {
  for (const k of KEY_VARS) {
    if (savedKeys[k] === undefined) delete process.env[k];
    else process.env[k] = savedKeys[k]!;
  }
}
const output = captured.join("");

try {
  // --- 4. The agent really did the work ------------------------------------
  assert.deepEqual(
    result.toolsUsed,
    [...DEMO_TOOL_SEQUENCE],
    "the agent must follow the recorded trajectory: plan, locate, read, reproduce, fix, re-run",
  );
  assert.equal(result.scriptTurns.used, result.scriptTurns.total, "every scripted turn is used");
  assert.ok(result.turns >= DEMO_SCRIPT.length - 1, "one agent turn per scripted reply");

  // The fix is on disk, written by the real edit engine — not merely narrated.
  assert.ok(result.sourceAfter.includes(FIXED_MEDIAN), "the corrected median must be on disk");
  assert.ok(!result.sourceAfter.includes(BUGGY_MEDIAN), "the buggy median must be gone");
  const onDisk = await fs.readFile(path.join(workspace, "src/stats.js"), "utf8");
  assert.equal(onDisk, result.sourceAfter);

  // The strongest assertion available: run the test ourselves, outside the
  // agent, and require it to pass now.
  const after = await exec("node", ["test/stats.test.js"], workspace, 30_000);
  assert.equal(after.ok, true, `the test must pass after the fix (stderr: ${after.stderr})`);
  assert.match(after.stdout, /stats: all tests passed/);

  // The agent observed both outcomes itself: a failing run then a passing one.
  assert.match(output, /run_shell\s+node test\/stats\.test\.js/);
  assert.ok(output.includes("Exit code: 1"), "the replay must show the reproduction failing");
  assert.ok(output.includes("Exit code: 0"), "and the confirmation passing");

  // --- 5. It is labelled a replay, and claims nothing more -----------------
  assert.match(output, /REPLAY/, "the replay must be labelled");
  assert.match(output, /pre-scripted/, "it must say the model replies are scripted");
  assert.match(output, /no network request is made/);
  assert.ok(
    (output.match(/REPLAY/g) ?? []).length >= 2,
    "the label must appear before and after the run, so it cannot be scrolled past",
  );
  for (const claim of ["live inference", "powered by", "thinking"]) {
    assert.ok(!output.toLowerCase().includes(claim), `must not imply "${claim}"`);
  }
  // The explanation the agent gives is shown, so the run is legible.
  assert.match(output, /Fixed `median`/);
  assert.match(output, new RegExp(DEMO_TASK.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  // --- 6. It cannot touch the user's workspace or leak credentials ---------
  const cwdEntriesAfter = await fs.readdir(cwdBefore);
  assert.deepEqual(
    cwdEntriesAfter.filter((e) => !cwdEntriesBefore.has(e)),
    [],
    "the demo must not create anything in the working directory",
  );
  assert.ok(result.workspaceRoot.startsWith(path.resolve(workspace)));
  assert.ok(!/sk-[A-Za-z0-9]{12,}|tvly-[A-Za-z0-9]{12,}/.test(output), "no key-shaped output");
  assert.ok(
    !/api[_-]?key["'\s]*[:=]/i.test(output),
    "the demo must never surface an api key assignment",
  );
} finally {
  await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
}

// --- 7. `--dir` keeps the workspace; the default cleans up ------------------
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-demo-keep-"));
  try {
    const r = await runDemo({ dir, out: () => {} });
    assert.equal(r.kept, true, "--dir implies the workspace is kept");
    await fs.access(path.join(dir, "src/stats.js"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  const ephemeral = await runDemo({ out: () => {} });
  assert.equal(ephemeral.kept, false);
  await assert.rejects(
    () => fs.access(ephemeral.workspaceRoot),
    "a temp workspace must be removed when not kept",
  );
}

// --- 8. The command is discoverable and needs no arguments ------------------
{
  const src = await fs.readFile(
    new URL("../packages/cli/src/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(src, /\.command\("demo"\)/, "`scissor demo` must be registered");
  const pkg = JSON.parse(
    await fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.match(pkg.scripts.demo ?? "", /index\.ts demo$/, "`npm run demo` must be wired");
  assert.ok(DEMO_TEST_COMMAND.startsWith("node "), "the demo must not depend on npm install");
}

process.stdout.write("test-demo: ALL PASS\n");
