import { promises as fs } from "node:fs";
import path from "node:path";
import fg from "fast-glob";

/**
 * Shared workspace file scanning: the ignore list, .gitignore reading, listing
 * candidate files, and reading text files (skipping binary/oversized). Both the
 * repo map / `retrieve` (repo-index.ts) and the `grep` tool (tools/search.ts)
 * build on this, so they share one ignore policy instead of drifting apart.
 */

export const DEFAULT_IGNORES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/.next/**",
  "**/coverage/**",
  "**/*.min.*",
  "**/*.tsbuildinfo",
  "**/*.lock",
  "**/package-lock.json",
];

export const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php", ".cs",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".swift", ".scala",
  ".md", ".json", ".yaml", ".yml", ".toml",
]);

/** Read .gitignore patterns into fast-glob-compatible ignore globs. */
export async function readGitignore(root: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    const patterns: string[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || t.startsWith("!")) continue;
      const clean = t.replace(/^\/+/, "").replace(/\/+$/, "");
      if (clean.includes("/")) patterns.push(clean, `${clean}/**`);
      else patterns.push(`**/${clean}`, `**/${clean}/**`);
    }
    return patterns;
  } catch {
    return [];
  }
}

export interface ListFilesOptions {
  /** Glob to match (default "**\/*"). */
  include?: string;
  /** Cap the number of returned files. */
  maxFiles?: number;
  /** Keep only recognized source/text extensions (see SOURCE_EXTENSIONS). */
  sourceOnly?: boolean;
}

/**
 * List workspace-relative files matching `include`, honoring DEFAULT_IGNORES
 * merged with the workspace .gitignore.
 */
export async function listWorkspaceFiles(
  root: string,
  opts: ListFilesOptions = {},
): Promise<string[]> {
  const ignore = [...DEFAULT_IGNORES, ...(await readGitignore(root))];
  const all = await fg(opts.include ?? "**/*", {
    cwd: root,
    ignore,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
    suppressErrors: true,
  });
  const filtered = opts.sourceOnly
    ? all.filter((f) => SOURCE_EXTENSIONS.has(path.extname(f).toLowerCase()))
    : all;
  return opts.maxFiles !== undefined ? filtered.slice(0, opts.maxFiles) : filtered;
}

export interface TextFile {
  content: string;
  lines: string[];
}

/**
 * Read a text file, returning null when it is missing, too large, unreadable,
 * or looks binary (contains a NUL byte).
 */
export async function readTextFile(
  abs: string,
  opts: { maxBytes?: number } = {},
): Promise<TextFile | null> {
  try {
    const stat = await fs.stat(abs);
    if (opts.maxBytes !== undefined && stat.size > opts.maxBytes) return null;
    const content = await fs.readFile(abs, "utf8");
    if (content.includes("\u0000")) return null;
    return { content, lines: content.split("\n") };
  } catch {
    return null;
  }
}
