import { tail } from "../text.js";
import { exec } from "./repo.js";

export interface VerifyResult {
  ok: boolean;
  step: string;
  detail: string;
}

/**
 * Verify that a (possibly self-modified) build is healthy before switching to
 * it. Runs type-check then build; both are deterministic and need no network.
 */
export async function verifyBuild(repo: string): Promise<VerifyResult> {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";

  const typecheck = await exec(npm, ["run", "typecheck"], repo, 300_000);
  if (!typecheck.ok) {
    return {
      ok: false,
      step: "typecheck",
      detail: tail(typecheck.stdout + "\n" + typecheck.stderr),
    };
  }

  const build = await exec(npm, ["run", "build"], repo, 300_000);
  if (!build.ok) {
    return { ok: false, step: "build", detail: tail(build.stdout + "\n" + build.stderr) };
  }

  return { ok: true, step: "build", detail: "type-check and build passed" };
}

/**
 * Run the eval suite against the (freshly built) code as a separate process, so
 * a self-edit that breaks the agent's actual behavior is caught. Skipped when
 * SCISSOR_SKIP_EVAL=1; a task subset can be set via SCISSOR_SELFUPDATE_EVAL_TASKS.
 */
export async function verifyEval(repo: string): Promise<VerifyResult> {
  if (process.env.SCISSOR_SKIP_EVAL === "1") {
    return { ok: true, step: "eval", detail: "skipped (SCISSOR_SKIP_EVAL=1)" };
  }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["run", "eval", "--", "--strict"];
  const tasks = process.env.SCISSOR_SELFUPDATE_EVAL_TASKS?.trim();
  if (tasks) args.push("--task", tasks);

  const r = await exec(npm, args, repo, 600_000);
  if (!r.ok) {
    return { ok: false, step: "eval", detail: tail(r.stdout + "\n" + r.stderr) };
  }
  return { ok: true, step: "eval", detail: "eval suite passed" };
}

/**
 * Full self-update gate: type-check + build, then the eval suite. Used before
 * reloading into a self-modified version.
 */
export async function verifySelfUpdate(repo: string): Promise<VerifyResult> {
  const build = await verifyBuild(repo);
  if (!build.ok) return build;
  const evalResult = await verifyEval(repo);
  if (!evalResult.ok) return evalResult;
  return { ok: true, step: "eval", detail: "type-check, build, and eval passed" };
}
