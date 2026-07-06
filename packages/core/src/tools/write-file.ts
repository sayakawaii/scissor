import { promises as fs } from "node:fs";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { applyEdits, type EditSpec } from "../edit-engine.js";
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

/** Collect edit specs from either the single-edit form or the `edits` array. */
function collectEdits(args: Record<string, unknown>): { edits: EditSpec[]; error?: string } {
  const raw = args.edits;
  if (Array.isArray(raw)) {
    const edits: EditSpec[] = [];
    for (const item of raw) {
      const o = item as Record<string, unknown>;
      const oldString = String(o.old_string ?? "");
      const newString = String(o.new_string ?? "");
      if (!oldString) return { edits: [], error: "each edit needs a non-empty 'old_string'." };
      edits.push({ oldString, newString, replaceAll: Boolean(o.replace_all) });
    }
    if (edits.length === 0) return { edits: [], error: "'edits' array is empty." };
    return { edits };
  }
  const oldString = String(args.old_string ?? "");
  const newString = String(args.new_string ?? "");
  if (!oldString) {
    return { edits: [], error: "provide 'old_string'/'new_string', or an 'edits' array." };
  }
  return { edits: [{ oldString, newString, replaceAll: Boolean(args.replace_all) }] };
}

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Make targeted edits to an existing file by replacing text. Matching tolerates line-ending (CRLF/LF) and trailing-whitespace differences, but a match must be unique unless replace_all is set. For several changes in one file, pass an 'edits' array (applied atomically). Copy old_string from the current file text.",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path." },
      old_string: {
        type: "string",
        description:
          "Text to replace (single-edit form). Include surrounding context to make it unique.",
      },
      new_string: { type: "string", description: "Replacement text (single-edit form)." },
      replace_all: {
        type: "boolean",
        description: "Replace every occurrence of old_string instead of requiring uniqueness.",
      },
      edits: {
        type: "array",
        description:
          "Multiple edits applied in order and atomically. Each item: { old_string, new_string, replace_all? }.",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string" },
            new_string: { type: "string" },
            replace_all: { type: "boolean" },
          },
          required: ["old_string", "new_string"],
        },
      },
    },
    required: ["path"],
  },
  async preview(args, ctx) {
    const target = String(args.path ?? "");
    const abs = resolveInWorkspace(ctx.workspaceRoot, target);
    const rel = displayPath(ctx.workspaceRoot, abs);
    const before = (await readIfExists(abs)) ?? "";
    const { edits, error } = collectEdits(args);
    if (error) {
      return { summary: `edit ${rel} (invalid)`, detail: error, dangerous: true };
    }
    const outcome = applyEdits(before, edits);
    if (!outcome.ok) {
      return {
        summary: `edit ${rel} (WARNING: will fail)`,
        detail: outcome.error ?? "edit could not be applied.",
        dangerous: true,
      };
    }
    const note = outcome.strategy && outcome.strategy !== "exact"
      ? ` [${outcome.strategy} match]`
      : "";
    return {
      summary: `edit ${rel}${edits.length > 1 ? ` (${edits.length} hunks)` : ""}${note}`,
      detail: makeDiff(rel, before, outcome.content!),
    };
  },
  async run(args, ctx) {
    const target = String(args.path ?? "");
    if (!target) return { content: "Error: 'path' is required.", isError: true };
    const { edits, error } = collectEdits(args);
    if (error) return { content: `Error: ${error}`, isError: true };
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
      const outcome = applyEdits(before, edits);
      if (!outcome.ok) {
        return { content: `Error editing "${target}": ${outcome.error}`, isError: true };
      }
      await fs.writeFile(abs, outcome.content!, "utf8");
      const rel = displayPath(ctx.workspaceRoot, abs);
      const noted = outcome.strategy && outcome.strategy !== "exact" ? ` (${outcome.strategy} match)` : "";
      return {
        content: `Edited ${rel}: ${outcome.replacements} replacement(s)${noted}.`,
      };
    } catch (err) {
      return {
        content: `Error editing "${target}": ${(err as Error).message}`,
        isError: true,
      };
    }
  },
};
