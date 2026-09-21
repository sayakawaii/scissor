/**
 * Heuristics for the test-first (TDD) gate: classify a workspace path as a test
 * file or a source-code file. Non-code files (docs, config, data) are neither,
 * so they are never blocked by the gate.
 */

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts",
  ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".kts", ".scala",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cxx",
  ".cs", ".rb", ".php", ".swift",
]);

function ext(p: string): string {
  const base = p.replace(/\\/g, "/").split("/").pop() ?? p;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot).toLowerCase() : "";
}

/** True when the path looks like an automated test file. */
export function isTestFile(p: string): boolean {
  const norm = p.replace(/\\/g, "/");
  const base = norm.split("/").pop() ?? norm;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(base)) return true; // foo.test.ts, bar.spec.jsx
  if (/(^|[._-])test[._-]/i.test(base) || /(^|[._-])test\.[a-z]+$/i.test(base)) return true; // test_foo.py, foo_test.go
  if (/_test\.[a-z]+$/i.test(base)) return true; // foo_test.go
  if (/(^|\/)(tests?|__tests__|spec|specs)(\/|$)/i.test(norm)) return true; // tests/, __tests__/
  return false;
}

/** True when the path is source code subject to the TDD gate. */
export function isSourceFile(p: string): boolean {
  return CODE_EXTENSIONS.has(ext(p)) && !isTestFile(p);
}
