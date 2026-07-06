/**
 * Robust single- and multi-hunk text editing.
 *
 * The model frequently gets `old_string` slightly wrong — most commonly line
 * endings (CRLF vs LF on Windows), trailing whitespace, or stray blank lines.
 * A strict exact-match edit then fails and wastes a turn. This engine tries a
 * ladder of increasingly tolerant strategies while staying safe: a fuzzy match
 * is only applied when it is *unique*, and unchanged lines are reconstructed
 * from the original source so their formatting is preserved exactly.
 */

export type MatchStrategy =
  | "exact"
  | "exact-all"
  | "whitespace"
  | "blank-trim";

export interface EditOutcome {
  ok: boolean;
  /** New full file content (present when ok). */
  content?: string;
  /** Number of replacements performed. */
  replacements?: number;
  /** Which strategy matched. */
  strategy?: MatchStrategy;
  /** Human-readable failure reason (present when !ok). */
  error?: string;
}

export interface EditSpec {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

function detectEol(s: string): "\r\n" | "\n" {
  return s.includes("\r\n") ? "\r\n" : "\n";
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

const stripTrailing = (line: string): string => line.replace(/[ \t]+$/, "");

/**
 * Find every window in `srcLines` (length = oldLines.length) that matches under
 * the given per-line normalizer. Returns start indices.
 */
function findLineBlocks(
  srcLines: string[],
  oldLines: string[],
  norm: (l: string) => string,
): number[] {
  const k = oldLines.length;
  if (k === 0 || k > srcLines.length) return [];
  const normalizedOld = oldLines.map(norm);
  const matches: number[] = [];
  for (let i = 0; i + k <= srcLines.length; i++) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (norm(srcLines[i + j]!) !== normalizedOld[j]) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push(i);
  }
  return matches;
}

/** Trim leading/trailing fully-blank lines from a line array. */
function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  return lines.slice(start, end);
}

/**
 * Apply one edit to `source`, trying tolerant strategies in order. Fuzzy matches
 * are applied only when unique.
 */
export function applyEdit(
  source: string,
  oldString: string,
  newString: string,
  opts: { replaceAll?: boolean } = {},
): EditOutcome {
  if (oldString.length === 0) {
    return { ok: false, error: "old_string must not be empty." };
  }
  if (oldString === newString) {
    return { ok: false, error: "old_string and new_string are identical." };
  }

  // --- Strategy 1: exact substring ---
  const exactCount = countOccurrences(source, oldString);
  if (exactCount > 0) {
    if (opts.replaceAll) {
      return {
        ok: true,
        content: source.split(oldString).join(newString),
        replacements: exactCount,
        strategy: "exact-all",
      };
    }
    if (exactCount === 1) {
      return {
        ok: true,
        content: source.replace(oldString, () => newString),
        replacements: 1,
        strategy: "exact",
      };
    }
    return {
      ok: false,
      error: `old_string matches ${exactCount} times; it must be unique. Add surrounding context, or pass replace_all to replace every occurrence.`,
    };
  }

  // --- Line-block fallbacks (handles CRLF/LF, trailing whitespace, blank lines) ---
  const eol = detectEol(source);
  const hadFinalNewline = /\r?\n$/.test(source);
  const srcLines = source.split(/\r?\n/);
  const oldLinesRaw = oldString.split(/\r?\n/);
  const newLines = newString.split(/\r?\n/);

  const rebuild = (matches: number[], oldLen: number): EditOutcome => {
    if (matches.length === 0) return { ok: false };
    if (matches.length > 1 && !opts.replaceAll) {
      const lineNos = matches.map((m) => m + 1).join(", ");
      return {
        ok: false,
        error: `old_string matches ${matches.length} locations (near lines ${lineNos}); it must be unique. Add surrounding context, or pass replace_all.`,
      };
    }
    // Apply from the bottom up so earlier indices stay valid.
    let out = srcLines.slice();
    let replacements = 0;
    for (const start of [...matches].sort((a, b) => b - a)) {
      out = [...out.slice(0, start), ...newLines, ...out.slice(start + oldLen)];
      replacements++;
    }
    let content = out.join(eol);
    if (hadFinalNewline && !/\r?\n$/.test(content)) content += eol;
    return { ok: true, content, replacements, strategy: "whitespace" };
  };

  // Strategy 2: trailing-whitespace + line-ending tolerant.
  const wsMatches = findLineBlocks(srcLines, oldLinesRaw, stripTrailing);
  const wsResult = rebuild(wsMatches, oldLinesRaw.length);
  if (wsResult.ok || wsResult.error) return wsResult;

  // Strategy 3: also ignore stray leading/trailing blank lines in old_string.
  const oldTrimmed = trimBlankEdges(oldLinesRaw);
  if (oldTrimmed.length > 0 && oldTrimmed.length !== oldLinesRaw.length) {
    const btMatches = findLineBlocks(srcLines, oldTrimmed, stripTrailing);
    const btResult = rebuild(btMatches, oldTrimmed.length);
    if (btResult.ok) return { ...btResult, strategy: "blank-trim" };
    if (btResult.error) return btResult;
  }

  // --- Not found: build a helpful near-miss hint ---
  return { ok: false, error: `old_string not found.${nearMissHint(srcLines, oldLinesRaw)}` };
}

/** Suggest where the model probably meant, to make the retry cheaper. */
function nearMissHint(srcLines: string[], oldLines: string[]): string {
  const firstOld = oldLines.find((l) => l.trim() !== "");
  if (!firstOld) return "";
  const needle = firstOld.trim();
  const hits: number[] = [];
  for (let i = 0; i < srcLines.length; i++) {
    if (srcLines[i]!.trim() === needle) hits.push(i + 1);
    if (hits.length >= 3) break;
  }
  if (hits.length > 0) {
    return ` A line matching "${truncate(needle, 60)}" exists at line ${hits.join(", ")}, but the surrounding block differs — re-read the file around there and copy the exact text.`;
  }
  return " Re-read the file to copy the exact current text.";
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/**
 * Apply multiple edits sequentially and atomically: each edit runs against the
 * result of the previous one; if any fails, nothing is applied.
 */
export function applyEdits(source: string, edits: EditSpec[]): EditOutcome {
  if (edits.length === 0) return { ok: false, error: "no edits provided." };
  let content = source;
  let total = 0;
  let lastStrategy: MatchStrategy | undefined;
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]!;
    const r = applyEdit(content, e.oldString, e.newString, { replaceAll: e.replaceAll });
    if (!r.ok) {
      return { ok: false, error: `edit #${i + 1}: ${r.error}` };
    }
    content = r.content!;
    total += r.replacements ?? 0;
    lastStrategy = r.strategy;
  }
  return { ok: true, content, replacements: total, strategy: lastStrategy };
}
