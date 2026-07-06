import { promises as fs } from "node:fs";
import path from "node:path";
import type { Tool } from "../types.js";
import { displayPath, isProtected, resolveInWorkspace } from "./paths.js";

const DEFAULT_MEMORY_FILE = "SCISSOR_MEMORY.md";
const LEARNED_HEADING = "## Learned";

/**
 * Persist a durable fact to the workspace's long-term memory file, which is
 * injected into the system prompt on future sessions. Use for stable project
 * facts (conventions, commands, gotchas) — not transient task state.
 */
export const rememberTool: Tool = {
  name: "remember",
  description:
    "Save a durable fact to long-term project memory (SCISSOR_MEMORY.md), which is loaded into context in future sessions. Use for stable facts the user would want remembered: conventions, key commands, architecture notes, gotchas. Do not use for transient task state.",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      fact: {
        type: "string",
        description: "A concise, self-contained fact to remember (one bullet).",
      },
    },
    required: ["fact"],
  },
  async preview(args, ctx) {
    const rel = ctx.memoryFile ?? DEFAULT_MEMORY_FILE;
    const fact = String(args.fact ?? "").trim();
    return {
      summary: `remember → ${rel}`,
      detail: `+ - ${fact}`,
    };
  },
  async run(args, ctx) {
    const fact = String(args.fact ?? "").trim();
    if (!fact) return { content: "Error: 'fact' is required.", isError: true };
    const rel = ctx.memoryFile ?? DEFAULT_MEMORY_FILE;
    let abs: string;
    try {
      abs = resolveInWorkspace(ctx.workspaceRoot, rel);
    } catch (err) {
      return { content: `Error: ${(err as Error).message}`, isError: true };
    }
    if (isProtected(ctx.workspaceRoot, abs, ctx.protectedPaths)) {
      return { content: `Error: "${rel}" is a protected path.`, isError: true };
    }
    try {
      let existing = "";
      try {
        existing = await fs.readFile(abs, "utf8");
      } catch {
        existing = "";
      }
      const bullet = `- ${fact}`;
      if (existing.includes(bullet)) {
        return { content: `Already remembered in ${displayPath(ctx.workspaceRoot, abs)}.` };
      }
      const next = appendUnderLearned(existing, bullet);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, next, "utf8");
      return { content: `Remembered in ${displayPath(ctx.workspaceRoot, abs)}: ${fact}` };
    } catch (err) {
      return { content: `Error writing memory: ${(err as Error).message}`, isError: true };
    }
  },
};

/** Append a bullet under a "## Learned" section, creating it if needed. */
export function appendUnderLearned(existing: string, bullet: string): string {
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  if (existing.trim() === "") {
    return `# scissor memory${eol}${eol}${LEARNED_HEADING}${eol}${eol}${bullet}${eol}`;
  }
  const lines = existing.split(/\r?\n/);
  const headingIdx = lines.findIndex((l) => l.trim().toLowerCase() === LEARNED_HEADING.toLowerCase());
  if (headingIdx === -1) {
    const trimmed = existing.replace(/\s+$/, "");
    return `${trimmed}${eol}${eol}${LEARNED_HEADING}${eol}${eol}${bullet}${eol}`;
  }
  // Insert after the last bullet in the Learned section (before the next heading).
  let insertAt = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^\s*#{1,6}\s/.test(lines[i]!)) {
      insertAt = i;
      break;
    }
  }
  // Trim trailing blank lines within the section before inserting.
  let end = insertAt;
  while (end > headingIdx + 1 && lines[end - 1]!.trim() === "") end--;
  lines.splice(end, 0, bullet);
  let out = lines.join(eol);
  if (!out.endsWith(eol)) out += eol;
  return out;
}
