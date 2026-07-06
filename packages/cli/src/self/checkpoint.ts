import { exec } from "./repo.js";

/** Current HEAD commit hash, or null if unavailable. */
export async function getHead(repo: string): Promise<string | null> {
  const r = await exec("git", ["rev-parse", "HEAD"], repo, 15_000);
  return r.ok ? r.stdout.trim() : null;
}

/** True if the working tree has uncommitted changes. */
export async function hasChanges(repo: string): Promise<boolean> {
  const r = await exec("git", ["status", "--porcelain"], repo, 15_000);
  return r.ok && r.stdout.trim().length > 0;
}

/**
 * Commit all current changes as a checkpoint. Returns the new HEAD hash, or the
 * existing HEAD if there was nothing to commit.
 */
export async function createCheckpoint(
  repo: string,
  message: string,
): Promise<{ ok: boolean; hash: string | null; detail: string }> {
  if (!(await hasChanges(repo))) {
    const head = await getHead(repo);
    return { ok: true, hash: head, detail: "no changes to checkpoint" };
  }
  const add = await exec("git", ["add", "-A"], repo, 30_000);
  if (!add.ok) return { ok: false, hash: null, detail: add.stderr || "git add failed" };
  const commit = await exec(
    "git",
    ["commit", "-m", message, "--no-verify"],
    repo,
    30_000,
  );
  if (!commit.ok) {
    return { ok: false, hash: null, detail: commit.stderr || "git commit failed" };
  }
  const head = await getHead(repo);
  return { ok: true, hash: head, detail: `checkpoint ${head?.slice(0, 8)}` };
}

/** Hard-reset the repo to a known-good commit and remove new tracked files. */
export async function rollbackTo(
  repo: string,
  hash: string,
): Promise<{ ok: boolean; detail: string }> {
  const reset = await exec("git", ["reset", "--hard", hash], repo, 30_000);
  if (!reset.ok) return { ok: false, detail: reset.stderr || "git reset failed" };
  // Remove untracked files created by the failed change (keeps gitignored deps).
  await exec("git", ["clean", "-fd"], repo, 30_000);
  return { ok: true, detail: `rolled back to ${hash.slice(0, 8)}` };
}
