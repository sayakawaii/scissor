/**
 * Deterministic test for the zero-key replay demo.
 *
 * The demo's value depends entirely on it being what it claims: a real agent
 * run with only the model's replies scripted. So the assertions below check the
 * claim rather than the narration.
 *
 * For `fix-bug` that means the seeded bug genuinely fails the test before the
 * run and the fix genuinely passes it after, verified by running the test from
 * here rather than believing the transcript.
 *
 * For `safety` it means proving the refusal comes from the command classifier
 * and not from the script: the scripted turn carries only a command, the
 * refusal text is reproduced independently from `classifyCommand` +
 * `denialMessage`, and the classifier is shown to be selective rather than
 * refusing everything. It also pins the rule that a denied command is a dead
 * end and never reaches the approval prompt.
 *
 * Both pin the honesty properties: the run must work with every provider key
 * removed from the environment, must not touch the user's working directory,
 * and must label itself a replay without claiming live inference.
 *
 * No network: the provider is a script.
 *
 * Run: node --import tsx scripts/test-demo.mts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyCommand,
  denialMessage,
  ScriptedProvider,
  SCRIPT_EXHAUSTED_TEXT,
  type ChatParams,
} from "@scissor/core";
import {
  assertSafetyLayerIntact,
  formatScenarioList,
  runDemo,
} from "../packages/cli/src/commands/demo.js";
import {
  BUGGY_MEDIAN,
  DEFAULT_SCENARIO_ID,
  FIXED_MEDIAN,
  getScenario,
  GIT_CLEAN,
  OVERBROAD_DELETE,
  SCENARIOS,
  SCOPED_DELETE,
  seedDemoWorkspace,
  type DemoScenario,
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

/** Run a scenario with every provider key stripped from the environment. */
async function runWithoutKeys(scenario: string, dir: string) {
  const saved: Record<string, string | undefined> = {};
  for (const k of KEY_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  const captured: string[] = [];
  try {
    const result = await runDemo({ scenario, dir, out: (s) => captured.push(s) });
    return { result, output: captured.join("") };
  } finally {
    for (const k of KEY_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
}

/** Assertions every scenario must satisfy, whatever it demonstrates. */
function assertCommonHonesty(scenario: DemoScenario, output: string, result: {
  toolsUsed: string[];
  scriptTurns: { used: number; total: number };
  outcomes: { label: string; ok: boolean }[];
}): void {
  assert.deepEqual(
    result.toolsUsed,
    [...scenario.toolSequence],
    `${scenario.id}: the agent must follow the recorded trajectory`,
  );
  assert.equal(
    result.scriptTurns.used,
    result.scriptTurns.total,
    `${scenario.id}: every scripted turn is used`,
  );
  for (const o of result.outcomes) {
    assert.ok(o.ok, `${scenario.id}: outcome must hold — ${o.label}`);
  }

  assert.match(output, /REPLAY/, `${scenario.id}: the replay must be labelled`);
  assert.match(output, /pre-scripted/, `${scenario.id}: it must say the replies are scripted`);
  assert.match(output, /no network request is made/);
  assert.ok(
    (output.match(/REPLAY/g) ?? []).length >= 2,
    `${scenario.id}: the label must appear before and after the run`,
  );
  for (const claim of ["live inference", "powered by"]) {
    assert.ok(!output.toLowerCase().includes(claim), `${scenario.id}: must not imply "${claim}"`);
  }
  assert.ok(
    !/sk-[A-Za-z0-9]{12,}|tvly-[A-Za-z0-9]{12,}/.test(output),
    `${scenario.id}: no key-shaped output`,
  );
  assert.ok(
    !/api[_-]?key["'\s]*[:=]/i.test(output),
    `${scenario.id}: must never surface an api key assignment`,
  );
}

// --- 1. ScriptedProvider: a pure lookup that never does I/O -----------------
{
  const p = new ScriptedProvider({
    script: [
      { text: "one", toolCalls: [] },
      { text: "two", toolCalls: [] },
    ],
  });
  assert.equal(p.turnCount, 2);
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
  assert.equal(p.model, "scripted-replay", "the model name must not look real");
}

// --- 2. The registry ---------------------------------------------------------
{
  assert.ok(SCENARIOS.length >= 2, "more than one scenario must be available");
  assert.ok(getScenario(DEFAULT_SCENARIO_ID), "the default scenario must exist");
  assert.equal(DEFAULT_SCENARIO_ID, "fix-bug", "the default must stay the one the README documents");
  const ids = SCENARIOS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "scenario ids must be unique");
  const list = formatScenarioList();
  for (const s of SCENARIOS) assert.ok(list.includes(s.id), `--list must mention ${s.id}`);
  await assert.rejects(
    () => runDemo({ scenario: "nope", out: () => {} }),
    /Unknown demo scenario/,
    "an unknown scenario is an error, not a silent fallback",
  );
}

// ===========================================================================
// Scenario: fix-bug
// ===========================================================================

// --- 3. The seeded bug is real: the test fails before the agent touches it ---
{
  const probe = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-demo-probe-"));
  try {
    const scenario = getScenario("fix-bug")!;
    await seedDemoWorkspace(probe, scenario);
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
}

// --- 4. The agent really fixes it, with no credentials available ------------
{
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-demo-fix-"));
  const cwdBefore = process.cwd();
  const cwdEntriesBefore = new Set(await fs.readdir(cwdBefore));
  try {
    const { result, output } = await runWithoutKeys("fix-bug", workspace);
    assertCommonHonesty(getScenario("fix-bug")!, output, result);

    // The fix is on disk, written by the real edit engine — not merely narrated.
    const onDisk = await fs.readFile(path.join(workspace, "src/stats.js"), "utf8");
    assert.ok(onDisk.includes(FIXED_MEDIAN), "the corrected median must be on disk");
    assert.ok(!onDisk.includes(BUGGY_MEDIAN), "the buggy median must be gone");

    // The strongest assertion available: run the test ourselves, outside the
    // agent, and require it to pass now.
    const after = await exec("node", ["test/stats.test.js"], workspace, 30_000);
    assert.equal(after.ok, true, `the test must pass after the fix (stderr: ${after.stderr})`);
    assert.match(after.stdout, /stats: all tests passed/);

    // The agent observed both outcomes itself: a failing run then a passing one.
    assert.ok(output.includes("Exit code: 1"), "the replay must show the reproduction failing");
    assert.ok(output.includes("Exit code: 0"), "and the confirmation passing");
    assert.match(output, /Fixed `median`/, "the agent's explanation is shown");

    const cwdEntriesAfter = await fs.readdir(cwdBefore);
    assert.deepEqual(
      cwdEntriesAfter.filter((e) => !cwdEntriesBefore.has(e)),
      [],
      "the demo must not create anything in the working directory",
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

// ===========================================================================
// Scenario: safety
// ===========================================================================

// --- 5. The refusal comes from the classifier, not from the script ----------
{
  const scenario = getScenario("safety")!;

  // (a) The classifier denies the over-broad delete, by the expected rule.
  const verdict = classifyCommand(OVERBROAD_DELETE);
  assert.equal(verdict.kind, "deny", "the over-broad delete must be denied outright");
  assert.equal(
    "rule" in verdict ? verdict.rule : undefined,
    "recursive-delete-of-root",
    "and denied by the rule the scenario is built around",
  );

  // (b) It is selective, not a blanket refusal — otherwise "it denied it" would
  //     prove nothing about the command.
  assert.equal(
    classifyCommand(SCOPED_DELETE).kind,
    "allow",
    "the scoped cleanup must be allowed, so the denial is a judgement not a blanket no",
  );
  assert.equal(classifyCommand("node test/widget.test.js").kind, "allow");
  const gitVerdict = classifyCommand(GIT_CLEAN);
  assert.equal(gitVerdict.kind, "confirm", "git clean is destructive-but-legitimate: ask, don't refuse");
  assert.equal("rule" in gitVerdict ? gitVerdict.rule : undefined, "hard-reset");

  // (c) The script cannot be the source of the refusal: it carries commands
  //     only, and none of the refusal wording appears anywhere in it.
  const scriptJson = JSON.stringify(scenario.script);
  for (const phrase of ["Refusing to run", "recursively delete", "not approvable", "User rejected"]) {
    assert.ok(
      !scriptJson.includes(phrase),
      `the scripted turns must not contain the refusal wording ${JSON.stringify(phrase)}`,
    );
  }
  const destructiveTurn = scenario.script.find((t) =>
    t.toolCalls.some((c) => c.arguments.command === OVERBROAD_DELETE),
  );
  assert.ok(destructiveTurn, "the scenario must really ask to run the destructive command");
  assert.equal(destructiveTurn!.text, "", "the scripted turn is a bare tool call, not prose");

  // (d) The demo fails closed: it refuses to start if the classifier regresses.
  const tampered: DemoScenario = {
    ...scenario,
    expectedVerdicts: [
      { command: OVERBROAD_DELETE, kind: "confirm", rule: "recursive-delete-of-root" },
    ],
  };
  // Exercise the guard through a scenario whose expectation no longer matches
  // reality; the demo must abort rather than hand the command to a shell.
  assert.throws(
    () => assertSafetyLayerIntact(tampered),
    /no longer returns/,
    "a classifier regression must stop the demo, not be papered over",
  );
}

// --- 6. The run: refused, declined, then done a scoped way ------------------
{
  const scenario = getScenario("safety")!;
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-demo-safety-"));
  const cwdBefore = process.cwd();
  const cwdEntriesBefore = new Set(await fs.readdir(cwdBefore));
  // A canary beside the workspace: nothing in the run may reach out of the tree.
  const canary = path.join(path.dirname(workspace), `scissor-demo-canary-${process.pid}`);
  await fs.writeFile(canary, "untouched", "utf8");

  try {
    const { result, output } = await runWithoutKeys("safety", workspace);
    assertCommonHonesty(scenario, output, result);

    // The denied command produced exactly the message core generates for it —
    // reproduced here from the classifier rather than compared to a fixture.
    const denied = result.blocked.find((b) => b.command === OVERBROAD_DELETE);
    assert.ok(denied, "the destructive command must have been blocked");
    const v = classifyCommand(OVERBROAD_DELETE);
    assert.equal(v.kind, "deny");
    assert.equal(
      denied!.message,
      denialMessage(OVERBROAD_DELETE, v as typeof v & { kind: "deny" }),
      "the refusal the agent received must be the one core produces, character for character",
    );
    assert.match(denied!.message, /Do not retry it or a variation of it/);

    // A denied command is a dead end, never a question: the approval gate must
    // not have been consulted for it.
    assert.ok(
      !result.approvals.some((a) => a.command === OVERBROAD_DELETE),
      "a categorically denied command must never reach the approval prompt",
    );
    // The confirm-tier command did reach it, and was declined.
    assert.deepEqual(
      result.approvals.filter((a) => a.command === GIT_CLEAN),
      [{ command: GIT_CLEAN, decision: "reject" }],
      "the destructive-but-legitimate command must be asked about, and was declined",
    );
    assert.ok(
      result.blocked.some((b) => b.command === GIT_CLEAN && /User rejected/.test(b.message)),
      "the declined command must not have run",
    );

    // The destructive effect did not occur: everything the command would have
    // taken out is still there.
    for (const survivor of ["src/widget.js", "test/widget.test.js", "package.json", "README.md"]) {
      await fs.access(path.join(workspace, survivor));
    }
    // ...and the job still got done, by the scoped delete: `rm -rf .` inside
    // build/ would have emptied the directory but left it, so the directory
    // being gone is evidence the node one-liner is what ran.
    await assert.rejects(
      () => fs.access(path.join(workspace, "build")),
      "build/ must have been removed by the scoped delete",
    );

    // Nothing outside the temp workspace was touched.
    assert.equal(await fs.readFile(canary, "utf8"), "untouched", "the canary must be untouched");
    assert.deepEqual(
      (await fs.readdir(cwdBefore)).filter((e) => !cwdEntriesBefore.has(e)),
      [],
      "the demo must not create anything in the working directory",
    );

    // The transcript shows the whole arc, not just the denial.
    assert.match(output, /refused by the command classifier/);
    assert.match(output, /approval required/);
    assert.match(output, /declined for the replay/);
    assert.ok(output.includes("Exit code: 0"), "the scoped cleanup and the tests must have run");
  } finally {
    await fs.rm(canary, { force: true }).catch(() => {});
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

// --- 7. `--dir` keeps the workspace; the default cleans up ------------------
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-demo-keep-"));
  try {
    const r = await runDemo({ dir, out: () => {} });
    assert.equal(r.kept, true, "--dir implies the workspace is kept");
    assert.equal(r.scenarioId, DEFAULT_SCENARIO_ID, "no --scenario runs the default");
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
  assert.match(src, /--scenario/, "the scenario selector must be wired");
  assert.match(src, /--list/, "`--list` must be wired");
  const pkg = JSON.parse(
    await fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.match(pkg.scripts.demo ?? "", /index\.ts demo$/, "`npm run demo` must be wired");
  for (const s of SCENARIOS) {
    for (const cmd of Object.values(s.files)) {
      assert.ok(!/npm (install|ci)\b/.test(cmd), "scenarios must not depend on npm install");
    }
  }
}

process.stdout.write("test-demo: ALL PASS\n");
