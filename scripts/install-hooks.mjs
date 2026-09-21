/**
 * Install scissor's git hooks by copying .githooks/* into .git/hooks/.
 * Runs automatically via the "prepare" npm lifecycle script (on `npm install`),
 * and can be run directly: `node scripts/install-hooks.mjs`.
 *
 * Uses .git/hooks/ directly (no `git config` changes). No-ops outside a git
 * checkout (e.g. when installed as a dependency).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(repoRoot, ".githooks");
const gitPath = path.join(repoRoot, ".git");

async function main() {
  // Resolve the hooks directory, handling both normal repos and worktrees
  // (where .git is a file pointing at the real gitdir).
  let gitDir;
  try {
    const stat = await fs.stat(gitPath);
    if (stat.isDirectory()) {
      gitDir = gitPath;
    } else {
      const content = await fs.readFile(gitPath, "utf8");
      const m = content.match(/^gitdir:\s*(.+)\s*$/m);
      gitDir = m ? path.resolve(repoRoot, m[1].trim()) : null;
    }
  } catch {
    gitDir = null;
  }
  if (!gitDir) {
    // Not a git checkout; nothing to install.
    return;
  }

  const hooksDir = path.join(gitDir, "hooks");
  await fs.mkdir(hooksDir, { recursive: true });

  let hooks;
  try {
    hooks = await fs.readdir(srcDir);
  } catch {
    return;
  }

  for (const name of hooks) {
    const src = path.join(srcDir, name);
    const dest = path.join(hooksDir, name);
    const body = await fs.readFile(src, "utf8");
    // Normalize to LF so the shebang works when git runs the hook via sh.
    await fs.writeFile(dest, body.replace(/\r\n/g, "\n"), "utf8");
    try {
      await fs.chmod(dest, 0o755);
    } catch {
      /* chmod is a no-op on Windows filesystems */
    }
    process.stdout.write(`[install-hooks] installed ${name} -> ${path.relative(repoRoot, dest)}\n`);
  }
}

main().catch((err) => {
  // Never fail an install because of hook setup.
  process.stderr.write(`[install-hooks] skipped: ${err?.message ?? err}\n`);
});
