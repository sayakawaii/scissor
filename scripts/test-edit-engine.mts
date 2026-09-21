/**
 * Deterministic test: the robust edit engine (applyEdit / applyEdits).
 * Covers CRLF/LF tolerance, trailing whitespace, blank-line trims, multi-hunk
 * atomicity, replace_all, uniqueness errors, near-miss hints, and within-line
 * substring edits. No network.
 *
 * Run: node --import tsx scripts/test-edit-engine.mts
 */
import assert from "node:assert/strict";
import { applyEdit, applyEdits } from "@scissor/core";

// 1. Exact within-line substring edit still works.
{
  const r = applyEdit("const x = 1;\n", "= 1", "= 2");
  assert.ok(r.ok && r.content === "const x = 2;\n", "exact within-line edit");
  assert.equal(r.strategy, "exact");
}

// 2. CRLF file, multi-line LF old_string -> whitespace strategy matches and
//    preserves CRLF line endings.
{
  const src = "line one\r\nline two\r\nline three\r\n";
  const r = applyEdit(src, "line one\nline two", "LINE ONE\nLINE TWO");
  assert.ok(r.ok, "CRLF/LF tolerant match applied");
  assert.equal(r.content, "LINE ONE\r\nLINE TWO\r\nline three\r\n", "preserves CRLF eol");
  assert.equal(r.strategy, "whitespace");
}

// 3. Trailing-whitespace difference tolerated.
{
  const src = "alpha   \nbeta\n"; // 'alpha' has trailing spaces in file
  const r = applyEdit(src, "alpha\nbeta", "alpha\nBETA");
  assert.ok(r.ok, "trailing whitespace tolerated");
  assert.equal(r.content, "alpha\nBETA\n");
}

// 4. Stray leading blank lines in old_string that don't exist in the file
//    (blank-trim). Two leading newlines vs the file's single separator.
{
  const src = "a\ntarget\nb\n";
  const r = applyEdit(src, "\n\ntarget", "TARGET");
  assert.ok(r.ok, "blank-trim match applied");
  assert.equal(r.strategy, "blank-trim");
  assert.equal(r.content, "a\nTARGET\nb\n");
}

// 5. Not unique -> error (no accidental replacement).
{
  const r = applyEdit("x\nx\n", "x", "y");
  assert.ok(!r.ok && /unique/.test(r.error ?? ""), "non-unique exact is rejected");
}

// 6. replace_all replaces every occurrence.
{
  const r = applyEdit("a a a\n", "a", "b", { replaceAll: true });
  assert.ok(r.ok && r.content === "b b b\n", "replace_all");
  assert.equal(r.replacements, 3);
  assert.equal(r.strategy, "exact-all");
}

// 7. Not found -> helpful near-miss hint pointing at the similar line. The
//    first old line exists (line 2) but the surrounding block differs.
{
  const src = "function foo() {\n  return 1;\n}\n";
  const r = applyEdit(src, "  return 1;\n  neverHere();", "  return 3;");
  assert.ok(!r.ok, "not found rejected");
  assert.ok(/line 2/.test(r.error ?? ""), "hint points at the similar line");
}

// 8. Multi-hunk atomic apply.
{
  const src = "one\ntwo\nthree\n";
  const r = applyEdits(src, [
    { oldString: "one", newString: "1" },
    { oldString: "three", newString: "3" },
  ]);
  assert.ok(r.ok, "multi-hunk applied");
  assert.equal(r.content, "1\ntwo\n3\n");
  assert.equal(r.replacements, 2);
}

// 9. Multi-hunk atomicity: if one edit fails, nothing is applied.
{
  const src = "one\ntwo\n";
  const r = applyEdits(src, [
    { oldString: "one", newString: "1" },
    { oldString: "nonexistent", newString: "x" },
  ]);
  assert.ok(!r.ok, "failing hunk rejects the whole batch");
  assert.ok(/edit #2/.test(r.error ?? ""), "identifies which hunk failed");
}

// 10. Identical old/new rejected.
{
  const r = applyEdit("abc\n", "abc", "abc");
  assert.ok(!r.ok && /identical/.test(r.error ?? ""), "no-op edit rejected");
}

process.stdout.write("\x1b[32mtest-edit-engine: ALL PASS\x1b[0m\n");
