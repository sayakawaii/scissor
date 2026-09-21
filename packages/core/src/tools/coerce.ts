/**
 * Lenient coercion of model-supplied tool arguments.
 *
 * Providers do not enforce our JSON schema, and every model gets this wrong in
 * the same handful of ways: an array arrives as its JSON *string*, a number as
 * "3", a boolean as "true", an enum in the wrong case. Failing the call wastes a
 * whole turn on a mistake we can read unambiguously, so we repair the shapes we
 * can prove and refuse the ones we would have to guess at.
 *
 * The guiding rule is "repair only when the intent is unambiguous". A scalar
 * string that looks like it holds several comma-separated items is NOT wrapped
 * into a one-element array, because `"a, b"` could equally be one item or two.
 */

/** Characters that make a JSON scalar look like it is really a list. */
const MULTI_ITEM = /,\s*\S|\n\s*\S/;

/**
 * `<parameter name="x">...</parameter>` markup that some models leak into the
 * argument value itself when they emit tool calls as text.
 */
const LEAKED_PARAMETER = /<parameter\s+name=["']?([^"'>\s]+)["']?\s*>([\s\S]*?)<\/parameter>/g;

function parseJsonArray(text: string): unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Scan a JSON-ish blob from its first `[` and return the first balanced array
 * plus whatever trailed it. Quote- and escape-aware so brackets inside strings
 * don't shift the depth count. Used to salvage `[...]` followed by junk.
 */
function firstBalancedArray(blob: string): { value: unknown[]; rest: string } | undefined {
  const start = blob.indexOf("[");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < blob.length; i++) {
    const c = blob[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === "[" || c === "{") {
      depth++;
    } else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        const value = parseJsonArray(blob.slice(start, i + 1));
        return value === undefined ? undefined : { value, rest: blob.slice(i + 1) };
      }
    }
  }
  return undefined;
}

export interface CoerceArrayOptions {
  /** Argument name, used to recognize markup that leaked this same parameter. */
  field?: string;
  /**
   * True when items are primitives (strings/numbers), which permits wrapping a
   * lone scalar into a single-element array. Never set this for object items.
   */
  primitiveItems?: boolean;
}

/**
 * Coerce a value to an array. Passes real arrays through untouched; repairs a
 * stringified array; returns undefined when the value cannot be read as a list
 * without guessing (the caller then reports a normal argument error).
 */
export function coerceArray(value: unknown, opts: CoerceArrayOptions = {}): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  // 1. The common case: a cleanly stringified array.
  const direct = parseJsonArray(trimmed);
  if (direct) return direct;

  // 2. Leaked parameter markup. Only unwrap when every leaked block names this
  //    same field exactly once — otherwise we'd be picking one of several
  //    arguments at random.
  const leaks = [...trimmed.matchAll(LEAKED_PARAMETER)];
  if (leaks.length > 0) {
    const mine = leaks.filter((m) => m[1] === opts.field);
    if (mine.length === 1 && leaks.length === 1) {
      const inner = parseJsonArray((mine[0]![2] ?? "").trim());
      if (inner) return inner;
    }
    return undefined;
  }

  // 3. A lone primitive scalar meant as a single-element array. Refused when it
  //    looks like it actually holds several items.
  if (opts.primitiveItems && !/^[[{]/.test(trimmed)) {
    if (MULTI_ITEM.test(trimmed)) return undefined;
    return [value];
  }

  // 4. A valid array followed by structural junk (a truncated or doubled emit).
  if (trimmed.startsWith("[")) {
    const balanced = firstBalancedArray(trimmed);
    if (balanced && /^[\s,\]}]*$/.test(balanced.rest)) return balanced.value;
  }
  return undefined;
}

/** Coerce a value to a finite number, accepting a numeric string. */
export function coerceNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Coerce a value to a boolean, accepting the usual string spellings. */
export function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "yes":
    case "1":
      return true;
    case "false":
    case "no":
    case "0":
      return false;
    default:
      return undefined;
  }
}

/**
 * Coerce a value to one of `allowed`, tolerating case and surrounding
 * whitespace. Returns undefined when it matches nothing.
 */
export function coerceEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  if (typeof value !== "string") return undefined;
  const needle = value.trim().toLowerCase();
  return allowed.find((a) => a.toLowerCase() === needle);
}

/**
 * Coerce a value to a list of non-empty trimmed strings. Convenience wrapper
 * for the many tools that take `string[]`.
 */
export function coerceStringArray(value: unknown, field?: string): string[] | undefined {
  const arr = coerceArray(value, { ...(field ? { field } : {}), primitiveItems: true });
  if (!arr) return undefined;
  return arr.map((v) => String(v).trim()).filter(Boolean);
}
