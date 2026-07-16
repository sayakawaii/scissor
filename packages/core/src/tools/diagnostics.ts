import { runProcess } from "../proc.js";
import { detectProjectChecks } from "../project-checks.js";
import type { Tool, ToolContext } from "../types.js";

const MAX_OUTPUT = 64 * 1024;
const MAX_LINES = 60;
const DEFAULT_TIMEOUT_MS = 120_000;

/** A parsed compiler/linter diagnostic. */
interface Diagnostic {
  file: string;
  line: number;
  col: number;
  severity: string;
  code?: string;
  message: string;
}

// `file.ts(12,5): error TS1234: message`  (tsc default format)
const TSC_RE = /^(.*?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;
// `file.ts:12:5: error message` / eslint-ish `file:12:5  error  message`
const COLON_RE = /^(.*?):(\d+):(\d+):?\s+(error|warning)\s+(.*)$/i;

function parseDiagnostics(output: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const tsc = TSC_RE.exec(line);
    if (tsc) {
      diags.push({
        file: tsc[1]!.trim(),
        line: Number(tsc[2]),
        col: Number(tsc[3]),
        severity: tsc[4]!,
        code: tsc[5],
        message: tsc[6]!.trim(),
      });
      continue;
    }
    const colon = COLON_RE.exec(line);
    if (colon) {
      diags.push({
        file: colon[1]!.trim(),
        line: Number(colon[2]),
        col: Number(colon[3]),
        severity: colon[4]!.toLowerCase(),
        message: colon[5]!.trim(),
      });
    }
  }
  return diags;
}

type Checker = "typecheck" | "lint";

const TSC_FALLBACK = "npx --no-install tsc --noEmit";

/**
 * Resolve the checker command to run. IMPORTANT (security): the command is never
 * taken from model/tool input — only from the project's own npm scripts,
 * tsconfig, or a user-controlled `SCISSOR_DIAGNOSTICS_COMMAND` env var. This
 * keeps `diagnostics` a read-only feedback tool rather than an arbitrary-command
 * side-channel that could bypass `run_shell`'s approval gate.
 */
async function detectCommand(
  workspaceRoot: string,
  checker?: Checker,
): Promise<string | undefined> {
  const checks = await detectProjectChecks(workspaceRoot);

  if (checker === "lint") return checks.lint?.command;
  if (checker === "typecheck") {
    return checks.typecheck?.command ?? (checks.hasTsconfig ? TSC_FALLBACK : undefined);
  }

  // Auto: a user-set env override wins, then typecheck, then lint, then tsc.
  const envOverride = process.env.SCISSOR_DIAGNOSTICS_COMMAND?.trim();
  if (envOverride) return envOverride;
  return (
    checks.typecheck?.command ??
    checks.lint?.command ??
    (checks.hasTsconfig ? TSC_FALLBACK : undefined)
  );
}

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number | null; output: string; started: boolean }> {
  const r = await runProcess(command, { cwd, timeoutMs, maxOutput: MAX_OUTPUT, signal });
  if (!r.started) {
    return { code: null, output: `Failed to start: ${r.stderr.trim()}`, started: false };
  }
  const output = r.timedOut ? `${r.output}\n(timed out after ${timeoutMs}ms)` : r.output;
  return { code: r.code, output, started: true };
}

export const diagnosticsTool: Tool = {
  name: "diagnostics",
  description:
    "Run the project's type-checker / linter and return structured diagnostics (file:line:col severity message) — real semantic feedback instead of guessing from grep. Use it after editing to confirm your change type-checks, or to locate errors. The command is auto-detected from the project's own `typecheck`/`lint` npm scripts or `tsc --noEmit` (tsconfig.json); you cannot pass an arbitrary command (use run_shell for that). Optional `checker` selects 'typecheck' or 'lint'; optional `path` filters results to one file. Read-only.",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      checker: {
        type: "string",
        enum: ["typecheck", "lint"],
        description:
          "Which check to run. Omit to auto-detect (typecheck preferred, else lint).",
      },
      path: {
        type: "string",
        description: "Optional workspace-relative file to filter diagnostics to.",
      },
    },
  },
  async run(args, ctx: ToolContext) {
    const checker =
      args.checker === "typecheck" || args.checker === "lint" ? args.checker : undefined;
    const command = await detectCommand(ctx.workspaceRoot, checker);
    if (!command) {
      return {
        content:
          `No ${checker ?? "type-checker"} detected (no matching npm script and no tsconfig.json). ` +
          "Configure a `typecheck`/`lint` script, or set SCISSOR_DIAGNOSTICS_COMMAND.",
        isError: false,
      };
    }

    const { code, output, started } = await runCommand(
      command,
      ctx.workspaceRoot,
      DEFAULT_TIMEOUT_MS,
      ctx.signal,
    );
    if (!started) {
      return { content: `Could not run \`${command}\`: ${output}`, isError: true };
    }

    let diags = parseDiagnostics(output);
    const filter = typeof args.path === "string" ? args.path.trim().replace(/\\/g, "/") : "";
    if (filter) {
      diags = diags.filter((d) => d.file.replace(/\\/g, "/").includes(filter));
    }

    if (diags.length > 0) {
      const shown = diags.slice(0, MAX_LINES);
      const body = shown
        .map(
          (d) =>
            `${d.file}:${d.line}:${d.col} ${d.severity}${d.code ? ` ${d.code}` : ""}: ${d.message}`,
        )
        .join("\n");
      const more = diags.length > shown.length ? `\n… and ${diags.length - shown.length} more` : "";
      return {
        content: `\`${command}\` reported ${diags.length} diagnostic(s)${filter ? ` for "${filter}"` : ""}:\n${body}${more}`,
        isError: false,
      };
    }

    // No parsed diagnostics: clean if exit 0, otherwise surface raw output.
    if (code === 0) {
      return { content: `No diagnostics from \`${command}\`.`, isError: false };
    }
    const trimmed = output.trim();
    return {
      content:
        `\`${command}\` exited with code ${code ?? "unknown"} but produced no parseable diagnostics` +
        (filter ? ` matching "${filter}"` : "") +
        (trimmed ? `:\n${trimmed.slice(0, 4000)}` : "."),
      isError: false,
    };
  },
};
