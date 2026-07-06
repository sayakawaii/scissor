/**
 * Deterministic test: supervisor restart/verify/rollback protocol.
 * Uses a real temp git repo (for checkpoint/rollback) but injects the child
 * runner and the build verifier, so no LLM or real build is needed.
 *
 * Run: node --import tsx scripts/test-selfupdate.mts
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-cfg-"));
process.env.SCISSOR_CONFIG_DIR = cfgDir;

const { saveSession, loadSession, newSessionId, getSessionPath } = await import(
  "@scissor/core"
);
const { runSupervisor } = await import(
  "../packages/cli/src/self/supervisor.js"
);
type SessionData = import("@scissor/core").SessionData;

function git(repo: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function makeRepo(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "scissor-repo-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@scissor.local");
  git(repo, "config", "user.name", "scissor test");
  await fs.writeFile(path.join(repo, "baseline.txt"), "baseline\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "baseline");
  return repo;
}

async function makeSession(repo: string): Promise<string> {
  const now = new Date().toISOString();
  const data: SessionData = {
    formatVersion: 1,
    id: newSessionId(),
    createdAt: now,
    updatedAt: now,
    provider: "deepseek",
    model: "deepseek-chat",
    workspaceRoot: repo,
    approvalPolicy: "plan-gate",
    generation: 0,
    messages: [],
  };
  await saveSession(data);
  return getSessionPath(data.id);
}

const noop = () => {};

// --- Scenario 1: good update is committed and reloaded ---
{
  const repo = await makeRepo();
  const sessionPath = await makeSession(repo);
  const okVerify = async () => ({ ok: true, step: "build", detail: "stub ok" });

  const runChild = async ({ generation }: { generation: number }) => {
    if (generation === 0) {
      await fs.writeFile(path.join(repo, "feature.txt"), "new feature\n");
      return 75; // request restart
    }
    return 0; // done
  };

  const code = await runSupervisor({
    repo,
    sessionPath,
    runChild,
    verify: okVerify,
    log: noop,
  });

  assert.equal(code, 0, "supervisor exits 0 after successful reload");
  assert.ok(
    await fs
      .stat(path.join(repo, "feature.txt"))
      .then(() => true)
      .catch(() => false),
    "good change persists",
  );
  const logLine = git(repo, "log", "--oneline");
  assert.ok(logLine.includes("self-update"), "checkpoint commit created");
  const session = await loadSession(sessionPath);
  assert.equal(session.generation, 1, "generation incremented");
  assert.ok(session.lastCheckpoint, "lastCheckpoint recorded");
  await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
  process.stdout.write("\x1b[32mscenario 1 (good update): PASS\x1b[0m\n");
}

// --- Scenario 2: failed verification rolls back ---
{
  const repo = await makeRepo();
  const baseline = git(repo, "rev-parse", "HEAD");
  const sessionPath = await makeSession(repo);
  let failedOnce = false;
  const failVerify = async () => {
    failedOnce = true;
    return { ok: false, step: "typecheck", detail: "stub type error" };
  };

  const runChild = async ({ generation }: { generation: number }) => {
    if (generation === 0) {
      await fs.writeFile(path.join(repo, "broken.txt"), "broken change\n");
      return 75;
    }
    // gen 1: after rollback, broken.txt must be gone.
    const exists = await fs
      .stat(path.join(repo, "broken.txt"))
      .then(() => true)
      .catch(() => false);
    assert.equal(exists, false, "broken change was rolled back before respawn");
    return 0;
  };

  const code = await runSupervisor({
    repo,
    sessionPath,
    runChild,
    verify: failVerify,
    log: noop,
  });

  assert.equal(code, 0, "supervisor recovers and exits 0");
  assert.ok(failedOnce, "verification was attempted");
  const head = git(repo, "rev-parse", "HEAD");
  assert.equal(head, baseline, "HEAD restored to baseline after rollback");
  const session = await loadSession(sessionPath);
  assert.ok(
    session.messages.some((m) => m.content.includes("failed verification")),
    "failure note appended to session for the agent",
  );
  await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
  process.stdout.write("\x1b[32mscenario 2 (rollback): PASS\x1b[0m\n");
}

// --- Scenario 3: eval-step failure also rolls back and notes the eval step ---
{
  const repo = await makeRepo();
  const baseline = git(repo, "rev-parse", "HEAD");
  const sessionPath = await makeSession(repo);
  const evalFailVerify = async () => ({
    ok: false as const,
    step: "eval",
    detail: "1/6 passed (17%) — fix-bug failed",
  });

  const runChild = async ({ generation }: { generation: number }) => {
    if (generation === 0) {
      await fs.writeFile(path.join(repo, "regress.txt"), "capability regression\n");
      return 75;
    }
    return 0;
  };

  const code = await runSupervisor({
    repo,
    sessionPath,
    runChild,
    verify: evalFailVerify,
    log: noop,
  });

  assert.equal(code, 0, "supervisor recovers from eval failure");
  assert.equal(git(repo, "rev-parse", "HEAD"), baseline, "rolled back after eval failure");
  const session = await loadSession(sessionPath);
  assert.ok(
    session.messages.some((m) => m.content.includes('"eval"')),
    "failure note names the eval step",
  );
  await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
  process.stdout.write("\x1b[32mscenario 3 (eval rollback): PASS\x1b[0m\n");
}

// --- verifyEval honors SCISSOR_SKIP_EVAL (no network / build) ---
{
  const { verifyEval } = await import("../packages/cli/src/self/verify.js");
  process.env.SCISSOR_SKIP_EVAL = "1";
  const r = await verifyEval(os.tmpdir());
  assert.ok(r.ok && r.step === "eval" && /skipped/.test(r.detail), "verifyEval respects SCISSOR_SKIP_EVAL");
  delete process.env.SCISSOR_SKIP_EVAL;
  process.stdout.write("\x1b[32mscenario 4 (eval skip env): PASS\x1b[0m\n");
}

await fs.rm(cfgDir, { recursive: true, force: true }).catch(() => {});
process.stdout.write("\x1b[32mtest-selfupdate: ALL PASS\x1b[0m\n");
