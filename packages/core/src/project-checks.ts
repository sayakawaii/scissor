import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Single source of truth for "how do I run this project's checks". Previously
 * the diagnostics tool and the CLI verification loop each re-implemented reading
 * package.json and resolving typecheck/lint commands, with subtly different
 * rules. This unifies the detection; callers layer their own overrides
 * (SCISSOR_DIAGNOSTICS_COMMAND, SCISSOR_VERIFY_COMMANDS) and fallbacks
 * (e.g. `npx tsc --noEmit`) on top.
 */

export interface DetectedCheck {
  /** The npm script key (e.g. "typecheck", "lint", "test"). */
  label: string;
  /** The command line to run (e.g. "npm run typecheck"). */
  command: string;
}

export interface ProjectChecks {
  typecheck?: DetectedCheck;
  lint?: DetectedCheck;
  test?: DetectedCheck;
  /** Whether a tsconfig.json exists (enables a `tsc --noEmit` fallback). */
  hasTsconfig: boolean;
}

async function readScripts(root: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(path.join(root, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

async function hasTsconfig(root: string): Promise<boolean> {
  try {
    await fs.stat(path.join(root, "tsconfig.json"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the project's typecheck / lint / test commands from its package.json
 * scripts (respecting common aliases), plus whether a tsconfig.json is present.
 * Commands run through a shell, so plain `npm` resolves (npm.cmd on Windows).
 */
export async function detectProjectChecks(root: string): Promise<ProjectChecks> {
  const scripts = await readScripts(root);
  const result: ProjectChecks = { hasTsconfig: await hasTsconfig(root) };

  const typecheckKey = ["typecheck", "type-check", "tsc"].find((k) => scripts[k]);
  if (typecheckKey) {
    result.typecheck = { label: typecheckKey, command: `npm run ${typecheckKey}` };
  }
  if (scripts["lint"]) {
    result.lint = { label: "lint", command: "npm run lint" };
  }
  if (scripts["test"]) {
    result.test = { label: "test", command: "npm test" };
  }
  return result;
}
