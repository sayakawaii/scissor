import { promises as fs } from "node:fs";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import type { Tool } from "../types.js";
import { displayPath, isProtected, resolveInWorkspace } from "./paths.js";

async function readIfExists(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
}

function makeDiff(rel: string, before: string, after: string): string {
  return createTwoFilesPatch(
    before === "" ? "/dev/null" : rel,
    rel,
    before,
    after,
    undefined,
    undefined,
    { context: 3 },
  );
}

export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "Create a new file or overwrite an existing file with the given content. Prefer edit_file for small changes to existing files.",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path." },
      content: { type: "string", description: "Full file content to write." },
    },
    required: ["path", "content"],
  },
  async preview(args, ctx) {
    const target = String(args.path ?? "");
    const abs = resolveInWorkspace(ctx.workspaceRoot, target);
    const rel = displayPath(ctx.workspaceRoot, abs);
    const before = (await readIfExists(abs)) ?? "";
    const after = String(args.content ?? "");
    return {
      summary: `${before === "" ? "create" : "overwrite"} ${rel}`,
      detail: makeDiff(rel, before, after),
    };
  },
  async run(args, ctx) {
    const target = String(args.path ?? "");
    if (!target) return { content: "Error: 'path' is required.", isError: true };
    const content = String(args.content ?? "");
    let abs: string;
    try {
      abs = resolveInWorkspace(ctx.workspaceRoot, target);
    } catch (err) {
      return { content: `Error: ${(err as Error).message}`, isError: true };
    }
    if (isProtected(ctx.workspaceRoot, abs, ctx.protectedPaths)) {
      return {
        content: `Error: "${target}" is a protected path and cannot be modified.`,
        isError: true,
      };
    }
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const existed = (await readIfExists(abs)) !== null;
      await fs.writeFile(abs, content, "utf8");
      const rel = displayPath(ctx.workspaceRoot, abs);
      return {
        content: `${existed ? "Overwrote" : "Created"} ${rel} (${content.length} bytes).`,
      };
    } catch (err) {
      return {
        content: `Error writing "${target}": ${(err as Error).message}`,
        isError: true,
      };
    }
  },
};

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Make a targeted edit to an existing file by replacing an exact string with a new one. The old_string must appear exactly once. Use for small, precise changes.",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path." },
      old_string: {
        type: "string",
        description:
          "Exact text to replace. Must be unique in the file. Include surrounding context to disambiguate.",
      },
      new_string: {
        type: "string",
        description: "Replacement text.",
      },
    },
    required: ["path", "old_string", "new_string"],
  },
  async preview(args, ctx) {
    const target = String(args.path ?? "");
    const abs = resolveInWorkspace(ctx.workspaceRoot, target);
    const rel = displayPath(ctx.workspaceRoot, abs);
    const before = (await readIfExists(abs)) ?? "";
    const oldStr = String(args.old_string ?? "");
    const newStr = String(args.new_string ?? "");
    const count = before.split(oldStr).length - 1;
    if (oldStr.length === 0 || count !== 1) {
      return {
        summary: `edit ${rel} (WARNING: old_string matches ${count} times)`,
        detail:
          count === 0
            ? "old_string not found in file."
            : "old_string is not unique; edit will fail.",
        dangerous: true,
      };
    }
    const after = before.replace(oldStr, newStr);
    return { summary: `edit ${rel}`, detail: makeDiff(rel, before, after) };
  },
  async run(args, ctx) {
    const target = String(args.path ?? "");
    if (!target) return { content: "Error: 'path' is required.", isError: true };
    const oldStr = String(args.old_string ?? "");
    const newStr = String(args.new_string ?? "");
    let abs: string;
    try {
      abs = resolveInWorkspace(ctx.workspaceRoot, target);
    } catch (err) {
      return { content: `Error: ${(err as Error).message}`, isError: true };
    }
    if (isProtected(ctx.workspaceRoot, abs, ctx.protectedPaths)) {
      return {
        content: `Error: "${target}" is a protected path and cannot be modified.`,
        isError: true,
      };
    }
    try {
      const before = await readIfExists(abs);
      if (before === null) {
        return { content: `Error: file "${target}" does not exist.`, isError: true };
      }
      const count = before.split(oldStr).length - 1;
      if (oldStr.length === 0) {
        return { content: "Error: 'old_string' must not be empty.", isError: true };
      }
      if (count === 0) {
        return {
          content: `Error: 'old_string' not found in "${target}".`,
          isError: true,
        };
      }
      if (count > 1) {
        return {
          content: `Error: 'old_string' matches ${count} times in "${target}"; must be unique.`,
          isError: true,
        };
      }
      const after = before.replace(oldStr, newStr);
      await fs.writeFile(abs, after, "utf8");
      return { content: `Edited ${displayPath(ctx.workspaceRoot, abs)}.` };
    } catch (err) {
      return {
        content: `Error editing "${target}": ${(err as Error).message}`,
        isError: true,
      };
    }
  },
};
