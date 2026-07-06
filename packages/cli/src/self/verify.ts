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

function tail(s: string, n = 2000): string {
  return s.length > n ? s.slice(s.length - n) : s;
}
