import { detectProjectChecks, type VerificationResult, type VerifyFn } from "@scissor/core";
import { execShell } from "./self/repo.js";
import { tail } from "./text.js";

export interface VerifyCommand {
  label: string;
  line: string;
}

/**
 * Detect a safe, fast set of verification commands for the workspace. Currently
 * targets Node projects (package.json scripts). Prefers type-checking and
 * linting over tests/builds, which can be slow or have side effects.
 */
export async function detectVerifyCommands(
  root: string,
  opts: { tdd?: boolean } = {},
): Promise<VerifyCommand[]> {
  // Explicit override via environment.
  const override = process.env.SCISSOR_VERIFY_COMMANDS;
  if (override && override.trim()) {
    return override
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line, i) => ({ label: `custom ${i + 1}`, line }));
  }

  const checks = await detectProjectChecks(root);
  const commands: VerifyCommand[] = [];
  if (checks.typecheck) {
    commands.push({ label: checks.typecheck.label, line: checks.typecheck.command });
  }
  if (checks.lint) commands.push({ label: checks.lint.label, line: checks.lint.command });
  // In TDD mode, correctness is proven by tests, so run them too.
  if (opts.tdd && checks.test) {
    commands.push({ label: checks.test.label, line: checks.test.command });
  }
  return commands;
}

/**
 * Build a VerifyFn for the workspace, or null when verification is disabled or
 * no commands are detected.
 */
export async function makeVerifier(
  root: string,
  opts: { enabled?: boolean; tdd?: boolean } = {},
): Promise<VerifyFn | undefined> {
  if (opts.enabled === false || process.env.SCISSOR_NO_VERIFY === "1") return undefined;
  const commands = await detectVerifyCommands(root, { tdd: opts.tdd });
  if (commands.length === 0) return undefined;

  return async (): Promise<VerificationResult> => {
    for (const cmd of commands) {
      const r = await execShell(cmd.line, root);
      if (!r.ok) {
        return {
          ok: false,
          summary: `verification failed: ${cmd.label} (exit ${r.code ?? "?"})`,
          output: tail((r.stdout + "\n" + r.stderr).trim(), 2500),
        };
      }
    }
    return {
      ok: true,
      summary: `${commands.length} check(s) passed: ${commands.map((c) => c.label).join(", ")}`,
    };
  };
}
