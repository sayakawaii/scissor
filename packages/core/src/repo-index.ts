import { promises as fs } from "node:fs";
import path from "node:path";
import { listWorkspaceFiles, readTextFile } from "./fs-scan.js";

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "is", "it", "for", "on",
  "with", "how", "what", "where", "why", "when", "do", "does", "this", "that",
  "i", "we", "you", "my", "our", "please", "can", "should", "add", "make",
  "fix", "use", "using", "find", "code", "file", "files", "function",
]);

/** List candidate source files (workspace-relative), respecting ignores. */
export async function listSourceFiles(
  root: string,
  maxFiles = 5000,
): Promise<string[]> {
  return listWorkspaceFiles(root, { maxFiles, sourceOnly: true });
}

/** Extract a handful of top-level symbol names from source text. */
export function extractSymbols(ext: string, content: string): string[] {
  const names = new Set<string>();
  const add = (m: RegExpMatchArray | null, group = 1) => {
    if (m && m[group]) names.add(m[group]);
  };
  const lines = content.split("\n");
  const e = ext.toLowerCase();

  const patterns: RegExp[] = [];
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(e)) {
    patterns.push(
      /export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/,
      /export\s+(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/,
      /export\s+(?:interface|type|enum)\s+([A-Za-z0-9_$]+)/,
      /export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/,
      /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)/,
      /^class\s+([A-Za-z0-9_$]+)/,
    );
  } else if (e === ".py") {
    patterns.push(/^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)/, /^\s*class\s+([A-Za-z0-9_]+)/);
  } else if (e === ".go") {
    patterns.push(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)/, /^type\s+([A-Za-z0-9_]+)/);
  } else if (e === ".rs") {
    patterns.push(/^\s*(?:pub\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z0-9_]+)/);
  } else if ([".java", ".kt", ".cs", ".scala"].includes(e)) {
    patterns.push(
      /(?:public|private|protected)\s+(?:class|interface)\s+([A-Za-z0-9_]+)/,
    );
  }

  for (const line of lines) {
    for (const re of patterns) {
      add(line.match(re));
      if (names.size >= 15) return [...names];
    }
  }
  return [...names];
}

export interface RepoMapOptions {
  maxChars?: number;
  maxFiles?: number;
}

/**
 * Build a compact "repository map": a directory-grouped listing of source files
 * annotated with their top-level symbols. Intended for the system prompt so the
 * agent starts with a mental model of the codebase.
 */
export async function buildRepoMap(
  root: string,
  opts: RepoMapOptions = {},
): Promise<string> {
  const maxChars = opts.maxChars ?? 6000;
  const files = await listSourceFiles(root, opts.maxFiles ?? 5000);
  if (files.length === 0) return "";

  const byDir = new Map<string, string[]>();
  for (const rel of files.sort()) {
    const dir = path.dirname(rel).split(path.sep).join("/");
    const key = dir === "." ? "(root)" : dir;
    if (!byDir.has(key)) byDir.set(key, []);
    byDir.get(key)!.push(rel);
  }

  const lines: string[] = [`${files.length} source files`];
  let truncated = false;

  outer: for (const [dir, dirFiles] of byDir) {
    lines.push(`${dir}/`);
    for (const rel of dirFiles) {
      let symbols: string[] = [];
      const ext = path.extname(rel).toLowerCase();
      if (ext !== ".json" && ext !== ".md") {
        try {
          const stat = await fs.stat(path.join(root, rel));
          if (stat.size <= 200 * 1024) {
            const content = await fs.readFile(path.join(root, rel), "utf8");
            symbols = extractSymbols(ext, content);
          }
        } catch {
          /* ignore */
        }
      }
      const base = path.basename(rel);
      const sym = symbols.length > 0 ? ` — ${symbols.slice(0, 12).join(", ")}` : "";
      lines.push(`  ${base}${sym}`);
      if (lines.join("\n").length > maxChars) {
        truncated = true;
        break outer;
      }
    }
  }

  let out = lines.join("\n");
  if (truncated) out += "\n... (map truncated; use glob/grep/retrieve for more)";
  return out;
}

export interface RetrieveResult {
  file: string;
  score: number;
  snippets: { line: number; text: string }[];
}

function tokenize(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((t) => t.length >= 2 && !STOPWORDS.has(t)),
    ),
  ];
}

/**
 * Heuristic keyword retrieval: rank source files by how strongly they match the
 * query tokens (path matches weighted higher), and return the best matching
 * lines from each. A cheap stand-in for embedding search.
 */
export async function retrieve(
  root: string,
  query: string,
  opts: { k?: number; maxFilesScanned?: number } = {},
): Promise<RetrieveResult[]> {
  return retrieveMulti(root, [query], opts);
}

/**
 * Multi-query retrieval: the caller (the model) rewrites a vague or typo-ridden
 * request into several normalized phrasings/keyword sets; we score every file
 * against each phrasing in a single pass and keep the *best* score per file, so
 * a file that strongly matches any one phrasing still surfaces. This lifts recall
 * for "where is X handled" questions without any embedding index.
 */
export async function retrieveMulti(
  root: string,
  queries: string[],
  opts: { k?: number; maxFilesScanned?: number } = {},
): Promise<RetrieveResult[]> {
  const k = opts.k ?? 8;
  const tokenSets = queries
    .map((q) => tokenize(q))
    .filter((t) => t.length > 0);
  if (tokenSets.length === 0) return [];
  // Union of all query tokens, used for snippet selection.
  const allTokens = [...new Set(tokenSets.flat())];
  const files = await listSourceFiles(root, opts.maxFilesScanned ?? 3000);

  const scored: RetrieveResult[] = [];
  for (const rel of files) {
    const file = await readTextFile(path.join(root, rel), { maxBytes: 512 * 1024 });
    if (!file) continue;
    const content = file.content;
    const lower = content.toLowerCase();
    const pathLower = rel.toLowerCase();

    // Score each phrasing independently; keep the strongest match.
    let best = 0;
    for (const tokens of tokenSets) {
      let score = 0;
      for (const tok of tokens) {
        const inContent = countOccurrences(lower, tok);
        const inPath = countOccurrences(pathLower, tok);
        score += inContent + inPath * 5;
      }
      if (score > best) best = score;
    }
    if (best <= 0) continue;

    // Find the best matching lines (those hitting the most distinct tokens).
    const contentLines = content.split("\n");
    const lineHits: { line: number; text: string; hits: number }[] = [];
    for (let i = 0; i < contentLines.length; i++) {
      const ll = (contentLines[i] ?? "").toLowerCase();
      let hits = 0;
      for (const tok of allTokens) if (ll.includes(tok)) hits++;
      if (hits > 0) {
        lineHits.push({ line: i + 1, text: (contentLines[i] ?? "").trim(), hits });
      }
    }
    lineHits.sort((a, b) => b.hits - a.hits || a.line - b.line);
    const snippets = lineHits.slice(0, 3).map((l) => ({ line: l.line, text: l.text.slice(0, 200) }));
    scored.push({ file: rel, score: best, snippets });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}
