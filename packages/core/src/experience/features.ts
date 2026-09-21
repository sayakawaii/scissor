/**
 * OaK-inspired experience layer — State Feature Extractor helpers (doc §3.1).
 *
 * Everything here is pure, deterministic, and — critically — produces
 * LOW-CARDINALITY, SECRET-FREE values. Raw user content, absolute paths, tokens,
 * and long identifiers must never survive into the experience store (doc §6, §7);
 * they would both blow up cardinality (making statistics meaningless) and turn
 * the store into a privacy hazard. The normalizers below collapse volatile text
 * into stable signatures instead.
 */

/**
 * Collapse an error/result string into a stable, secret-free signature.
 *
 * Strategy: drop anything that varies run-to-run or could carry secrets —
 * quoted strings, file paths, URLs, hex/uuid/hashes, numbers — replacing each
 * with a coarse placeholder, then clip length. Two failures of the "same shape"
 * (e.g. `Cannot find module 'x'`) map to one signature regardless of the
 * specific identifier, so per-bucket error counts stay low-cardinality.
 */
export function normalizeErrorSignature(input: string | undefined): string | undefined {
  if (input === undefined || input === null) return undefined;
  let s = String(input);
  if (!s.trim()) return undefined;

  // Only keep the first line / first sentence-ish chunk: stack traces and long
  // dumps add noise and can carry paths. The head usually names the error.
  s = s.split(/\r?\n/, 1)[0] ?? "";

  s = s
    // Windows + POSIX absolute/relative paths and drive letters.
    .replace(/[a-zA-Z]:\\[^\s'"]+/g, "<path>")
    .replace(/\/[^\s'"]+/g, "<path>")
    .replace(/(?:\.\.?[\\/])[^\s'"]+/g, "<path>")
    // URLs.
    .replace(/[a-z]+:\/\/[^\s'"]+/gi, "<url>")
    // Quoted string contents (module names, identifiers, secrets).
    .replace(/'[^']*'/g, "'<x>'")
    .replace(/"[^"]*"/g, '"<x>"')
    .replace(/`[^`]*`/g, "`<x>`")
    // Long hex / uuids / hashes.
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    // Bare numbers (line/col, sizes, ports).
    .replace(/\b\d+\b/g, "<n>")
    // Collapse whitespace.
    .replace(/\s+/g, " ")
    .trim();

  if (!s) return undefined;
  // Clip to keep cardinality and storage bounded.
  return s.length > 120 ? s.slice(0, 120) : s;
}

/** Map a raw workspace file count into a coarse, stable size bucket. */
export function bucketWorkspaceSize(fileCount: number | undefined): string {
  if (typeof fileCount !== "number" || !Number.isFinite(fileCount) || fileCount < 0) {
    return "unknown";
  }
  if (fileCount < 25) return "xs";
  if (fileCount < 100) return "sm";
  if (fileCount < 500) return "md";
  if (fileCount < 2000) return "lg";
  return "xl";
}

/** Order state keys deterministically so the bucket string is stable. */
function sortedEntries(
  state: Record<string, string | number | boolean>,
): Array<[string, string | number | boolean]> {
  return Object.entries(state)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Derive a stable, low-cardinality bucket key from a state feature record.
 * Keys are sorted so the same features always yield the same bucket regardless
 * of insertion order. Values are coerced to compact strings; this is the join
 * key the experience model aggregates on (doc §3.4).
 */
export function deriveStateBucket(
  state: Record<string, string | number | boolean> | undefined,
): string {
  if (!state) return "-";
  const parts = sortedEntries(state).map(([k, v]) => `${k}=${String(v)}`);
  return parts.length ? parts.join(",") : "-";
}
