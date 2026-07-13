import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
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

async function detectCommand(workspaceRoot: string): Promise<string | undefined> {
  try {
    const pkgRaw = await fs.readFile(path.join(workspaceRoot, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    if (scripts.typecheck) return "npm run typecheck";
    if (scripts["type-check"]) return "npm run type-check";
    if (scripts.lint) return "npm run lint";
  } catch {
    /* no package.json / unreadable */
  }
  try {
    await fs.stat(path.join(workspaceRoot, "tsconfig.json"));
    return "npx --no-install tsc --noEmit";
  } catch {
    /* no tsconfig */
  }
  return undefined;
}

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number | null; output: string; started: boolean }> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const shell = isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
    const shellArgs = isWin ? ["/d", "/s", "/c", command] : ["-c", command];
    const child = spawn(shell, shellArgs, { cwd, env: process.env, windowsHide: true });

    let output = "";
    let truncated = false;
    const append = (buf: Buffer) => {
      if (truncated) return;
      output += buf.toString();
      if (output.length > MAX_OUTPUT) {
        output = output.slice(0, MAX_OUTPUT);
        truncated = true;
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null, output: output + `\n(timed out after ${timeoutMs}ms)`, started: true });
    }, timeoutMs);

    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code: null, output: `Failed to start: ${err.message}`, started: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, output, started: true });
    });
  });
}

export const diagnosticsTool: Tool = {
  name: "diagnostics",
  description:
    "Run the project's type-checker / linter and return structured diagnostics (file:line:col severity message) — real semantic feedback instead of guessing from grep. Use it after editing to confirm your change type-checks, or to locate errors. Auto-detects a `typecheck`/`lint` npm script or `tsc --noEmit` from tsconfig.json; pass `command` to override, or `path` to filter results to one file. Read-only.",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          "Optional checker command to run (e.g. 'npm run typecheck', 'npx tsc --noEmit'). If omitted, one is detected.",
      },
      path: {
        type: "string",
        description: "Optional workspace-relative file to filter diagnostics to.",
      },
    },
  },
  async run(args, ctx: ToolContext) {
    const override = typeof args.command === "string" ? args.command.trim() : "";
    const command = override || (await detectCommand(ctx.workspaceRoot));
    if (!command) {
      return {
        content:
          "No type-checker detected (no `typecheck`/`lint` npm script and no tsconfig.json). " +
          "Pass a `command` argument to specify one.",
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
