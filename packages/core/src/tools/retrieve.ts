import { retrieve } from "../repo-index.js";
import type { Tool } from "../types.js";

export const retrieveTool: Tool = {
  name: "retrieve",
  description:
    "Find the most relevant files for a natural-language query using ranked keyword search across the workspace. Returns files ordered by relevance with matching lines. Use this first to locate where something is handled before reading files; it is smarter than a single grep for multi-word questions.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What you are looking for, in words (e.g. 'where are api keys loaded from config').",
      },
      k: {
        type: "number",
        description: "Max number of files to return (default 8).",
      },
    },
    required: ["query"],
  },
  async run(args, ctx) {
    const query = String(args.query ?? "");
    if (!query.trim()) return { content: "Error: 'query' is required.", isError: true };
    const k = typeof args.k === "number" && args.k > 0 ? Math.min(args.k, 20) : 8;
    try {
      const results = await retrieve(ctx.workspaceRoot, query, { k });
      if (results.length === 0) {
        return { content: "No relevant files found for that query." };
      }
      const out = results
        .map((r) => {
          const head = `${r.file}  (score ${r.score})`;
          const lines = r.snippets
            .map((s) => `    ${s.line}: ${s.text}`)
            .join("\n");
          return lines ? `${head}\n${lines}` : head;
        })
        .join("\n");
      return { content: out };
    } catch (err) {
      return { content: `Error: ${(err as Error).message}`, isError: true };
    }
  },
};
