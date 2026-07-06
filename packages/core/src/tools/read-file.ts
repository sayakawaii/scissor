import { promises as fs } from "node:fs";
import type { Tool } from "../types.js";
import { displayPath, resolveInWorkspace } from "./paths.js";

const MAX_BYTES = 256 * 1024;

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read the contents of a text file within the workspace. Returns the file with 1-based line numbers. Use for inspecting code or docs before editing.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Workspace-relative path to the file to read.",
      },
      start_line: {
        type: "number",
        description: "Optional 1-based start line (inclusive).",
      },
      end_line: {
        type: "number",
        description: "Optional 1-based end line (inclusive).",
      },
    },
    required: ["path"],
  },
  async run(args, ctx) {
    const target = String(args.path ?? "");
    if (!target) return { content: "Error: 'path' is required.", isError: true };
    let abs: string;
    try {
      abs = resolveInWorkspace(ctx.workspaceRoot, target);
    } catch (err) {
      return { content: `Error: ${(err as Error).message}`, isError: true };
    }

    try {
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) {
        return { content: `Error: "${target}" is a directory.`, isError: true };
      }
      if (stat.size > MAX_BYTES) {
        return {
          content: `Error: file too large (${stat.size} bytes, limit ${MAX_BYTES}).`,
          isError: true,
        };
      }
      const raw = await fs.readFile(abs, "utf8");
      const lines = raw.split("\n");
      const start = clampLine(args.start_line, 1, lines.length);
      const end = clampLine(args.end_line, start, lines.length, lines.length);
      const slice = lines.slice(start - 1, end);
      const width = String(end).length;
      const numbered = slice
        .map((line, i) => `${String(start + i).padStart(width)} | ${line}`)
        .join("\n");
      const header = `${displayPath(ctx.workspaceRoot, abs)} (lines ${start}-${end} of ${lines.length})`;
      return { content: `${header}\n${numbered}` };
    } catch (err) {
      return {
        content: `Error reading "${target}": ${(err as Error).message}`,
        isError: true,
      };
    }
  },
};

function clampLine(
  value: unknown,
  min: number,
  max: number,
  fallback = min,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}
