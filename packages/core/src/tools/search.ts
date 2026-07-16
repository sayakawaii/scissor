import { listWorkspaceFiles, readTextFile } from "../fs-scan.js";
import type { Tool } from "../types.js";
import { displayPath, resolveInWorkspace } from "./paths.js";

const MAX_RESULTS = 100;
const MAX_FILE_BYTES = 1024 * 1024;

export const globTool: Tool = {
  name: "glob",
  description:
    "Find files by glob pattern within the workspace (e.g. 'src/**/*.ts'). Returns matching file paths.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern, workspace-relative. Example: '**/*.ts'.",
      },
    },
    required: ["pattern"],
  },
  async run(args, ctx) {
    const pattern = String(args.pattern ?? "");
    if (!pattern) return { content: "Error: 'pattern' is required.", isError: true };
    try {
      const matches = await listWorkspaceFiles(ctx.workspaceRoot, { include: pattern });
      if (matches.length === 0) return { content: "No files matched." };
      const shown = matches.slice(0, MAX_RESULTS);
      const suffix =
        matches.length > MAX_RESULTS
          ? `\n... and ${matches.length - MAX_RESULTS} more`
          : "";
      return { content: shown.join("\n") + suffix };
    } catch (err) {
      return { content: `Error: ${(err as Error).message}`, isError: true };
    }
  },
};

export const grepTool: Tool = {
  name: "grep",
  description:
    "Search file contents for a regular expression within the workspace. Returns matching lines with file:line prefixes.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regular expression to search for (JavaScript regex syntax).",
      },
      include: {
        type: "string",
        description:
          "Optional glob to restrict which files are searched, e.g. '**/*.ts'.",
      },
      ignore_case: {
        type: "boolean",
        description: "Case-insensitive search when true.",
      },
    },
    required: ["pattern"],
  },
  async run(args, ctx) {
    const patternStr = String(args.pattern ?? "");
    if (!patternStr) return { content: "Error: 'pattern' is required.", isError: true };
    let regex: RegExp;
    try {
      regex = new RegExp(patternStr, args.ignore_case ? "i" : undefined);
    } catch (err) {
      return { content: `Error: invalid regex: ${(err as Error).message}`, isError: true };
    }
    const include = args.include ? String(args.include) : undefined;
    try {
      const files = await listWorkspaceFiles(ctx.workspaceRoot, { include });
      const results: string[] = [];
      for (const rel of files) {
        if (results.length >= MAX_RESULTS) break;
        let abs: string;
        try {
          abs = resolveInWorkspace(ctx.workspaceRoot, rel);
        } catch {
          continue;
        }
        const file = await readTextFile(abs, { maxBytes: MAX_FILE_BYTES });
        if (!file) continue;
        for (let i = 0; i < file.lines.length; i++) {
          if (results.length >= MAX_RESULTS) break;
          if (regex.test(file.lines[i] ?? "")) {
            results.push(`${displayPath(ctx.workspaceRoot, abs)}:${i + 1}: ${(file.lines[i] ?? "").trim()}`);
          }
        }
      }
      if (results.length === 0) return { content: "No matches found." };
      const suffix = results.length >= MAX_RESULTS ? "\n... (results truncated)" : "";
      return { content: results.join("\n") + suffix };
    } catch (err) {
      return { content: `Error: ${(err as Error).message}`, isError: true };
    }
  },
};
