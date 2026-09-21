import { promises as fs } from "node:fs";
import path from "node:path";
import { execShell } from "../self/repo.js";

/**
 * Filesystem + run helpers shared by the eval and bench task suites. Both files
 * previously defined their own identical copies of these; keeping one set avoids
 * drift and makes new tasks cheaper to add.
 */

/** Write `content` to `dir/rel`, creating parent directories. */
export async function write(dir: string, rel: string, content: string): Promise<void> {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

/** Read `dir/rel` as UTF-8 text. */
export async function read(dir: string, rel: string): Promise<string> {
  return fs.readFile(path.join(dir, rel), "utf8");
}

/** Whether `dir/rel` exists. */
export async function exists(dir: string, rel: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, rel));
    return true;
  } catch {
    return false;
  }
}

/** Run `node <script>` in `dir` and return trimmed combined stdout/stderr. */
export async function runNode(
  dir: string,
  script: string,
  timeoutMs = 20_000,
): Promise<{ ok: boolean; out: string }> {
  const r = await execShell(`node ${script}`, dir, timeoutMs);
  return { ok: r.ok, out: (r.stdout + r.stderr).trim() };
}
