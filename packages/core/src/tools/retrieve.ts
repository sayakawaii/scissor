import { retrieveMulti } from "../repo-index.js";
import type { Tool } from "../types.js";

export const retrieveTool: Tool = {
  name: "retrieve",
  description:
    "Find the most relevant files for a natural-language query using ranked keyword search across the workspace. Returns files ordered by relevance with matching lines. Use this first to locate where something is handled before reading files; it is smarter than a single grep for multi-word questions. If the user's wording is vague, abbreviated, or misspelled, REWRITE it: pass `queries` with 2-4 normalized phrasings (corrected spelling, likely identifier/function names, and synonyms) to maximize the chance of a hit.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What you are looking for, in words (e.g. 'where are api keys loaded from config').",
      },
      queries: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional alternative phrasings/keyword sets for the same intent (e.g. ['load api key from config', 'apiKey environment variable', 'readConfig']). Results are merged, keeping the best match per file. Use this to recover from vague or misspelled requests.",
      },
      k: {
        type: "number",
        description: "Max number of files to return (default 8).",
      },
    },
  },
  async run(args, ctx) {
    const queries: string[] = [];
    if (typeof args.query === "string") queries.push(args.query);
    if (Array.isArray(args.queries)) {
      for (const q of args.queries) if (typeof q === "string") queries.push(q);
    }
    const nonEmpty = queries.map((q) => q.trim()).filter(Boolean);
    if (nonEmpty.length === 0) {
      return { content: "Error: provide 'query' or 'queries'.", isError: true };
    }
    const k = typeof args.k === "number" && args.k > 0 ? Math.min(args.k, 20) : 8;
    try {
      const results = await retrieveMulti(ctx.workspaceRoot, nonEmpty, { k });
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
