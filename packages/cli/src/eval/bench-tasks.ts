import { promises as fs } from "node:fs";
import path from "node:path";
import { execShell } from "../self/repo.js";
import type { EvalTask } from "./tasks.js";

async function write(dir: string, rel: string, content: string): Promise<void> {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}
async function read(dir: string, rel: string): Promise<string> {
  return fs.readFile(path.join(dir, rel), "utf8");
}
async function exists(dir: string, rel: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, rel));
    return true;
  } catch {
    return false;
  }
}
async function node(dir: string, cmd: string): Promise<{ ok: boolean; out: string }> {
  const r = await execShell(`node ${cmd}`, dir, 25_000);
  return { ok: r.ok, out: (r.stdout + r.stderr).trim() };
}

/**
 * Harder, more differentiating scenarios than the quick eval suite. These probe
 * multi-step work: scaffolding, debugging a real failing test, multi-file
 * refactors, data transforms, and retrieval in a larger tree — the areas where
 * capable agents (e.g. goose) and scissor should be compared.
 */
export const BENCH_TASKS: EvalTask[] = [
  {
    id: "fibonacci-cli",
    title: "Scaffold a small CLI that computes Fibonacci",
    tags: ["write", "reason", "shell"],
    prompt:
      "Create a Node.js script cli.js that reads an integer N from process.argv[2] and prints the Nth Fibonacci number (0-indexed, so fib(0)=0, fib(1)=1, fib(10)=55). Print only the number. Verify it runs.",
    async check(dir) {
      if (!(await exists(dir, "cli.js"))) return { pass: false, detail: "cli.js not created" };
      const a = await node(dir, "cli.js 10");
      const b = await node(dir, "cli.js 0");
      if (!a.ok || !b.ok) return { pass: false, detail: `run failed: ${(a.out || b.out).slice(0, 80)}` };
      if (a.out !== "55") return { pass: false, detail: `fib(10) => ${JSON.stringify(a.out)}, expected 55` };
      if (b.out !== "0") return { pass: false, detail: `fib(0) => ${JSON.stringify(b.out)}, expected 0` };
      return { pass: true, detail: "fib(10)=55, fib(0)=0" };
    },
  },
  {
    id: "fix-failing-test",
    title: "Debug and fix a failing test",
    tags: ["read", "edit", "shell", "debug"],
    async setup(dir) {
      await write(dir, "sum.js", "function sum(a, b) {\n  return a - b; // bug\n}\nmodule.exports = { sum };\n");
      await write(
        dir,
        "test.js",
        [
          "const { sum } = require('./sum.js');",
          "if (sum(2, 3) === 5 && sum(10, 5) === 15) {",
          "  console.log('PASS');",
          "} else {",
          "  console.error('FAIL: sum(2,3)=' + sum(2,3));",
          "  process.exit(1);",
          "}",
          "",
        ].join("\n"),
      );
    },
    prompt:
      "Running `node test.js` fails. Investigate and fix the bug in sum.js so the test passes. Do not edit test.js.",
    async check(dir) {
      const r = await node(dir, "test.js");
      if (!r.ok) return { pass: false, detail: `test still fails: ${r.out.slice(0, 80)}` };
      if (!r.out.includes("PASS")) return { pass: false, detail: `no PASS: ${JSON.stringify(r.out)}` };
      const src = await read(dir, "sum.js");
      if (!/a\s*\+\s*b/.test(src)) return { pass: false, detail: "sum.js not fixed to a + b" };
      return { pass: true, detail: "test passes (sum fixed)" };
    },
  },
  {
    id: "multi-file-refactor",
    title: "Rename an exported symbol across multiple files",
    tags: ["edit", "multi-file"],
    async setup(dir) {
      await write(dir, "math.js", "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n");
      await write(
        dir,
        "main.js",
        "const { add } = require('./math.js');\nconsole.log(add(20, 22));\n",
      );
    },
    prompt:
      "Rename the exported function `add` to `sum` across the whole project (math.js and main.js): the definition, the export, the import, and the call. Keep behavior identical.",
    async check(dir) {
      const math = await read(dir, "math.js");
      const main = await read(dir, "main.js");
      if (/\badd\b/.test(math) || /\badd\b/.test(main)) {
        return { pass: false, detail: "`add` still present somewhere" };
      }
      if (!/\bsum\b/.test(math) || !/\bsum\b/.test(main)) {
        return { pass: false, detail: "`sum` not present in both files" };
      }
      const r = await node(dir, "main.js");
      if (!r.ok) return { pass: false, detail: `main.js failed: ${r.out.slice(0, 80)}` };
      return r.out === "42"
        ? { pass: true, detail: "renamed across files, prints 42" }
        : { pass: false, detail: `output changed: ${JSON.stringify(r.out)}` };
    },
  },
  {
    id: "csv-sum",
    title: "Write a script to sum a CSV column",
    tags: ["write", "reason", "shell"],
    async setup(dir) {
      await write(
        dir,
        "data.csv",
        ["name,amount", "alice,10", "bob,25", "carol,7", "dave,100", ""].join("\n"),
      );
    },
    prompt:
      "Write parse.js that reads data.csv (columns: name,amount) and prints the sum of the amount column (a single number) to stdout. The correct total is 142.",
    async check(dir) {
      if (!(await exists(dir, "parse.js"))) return { pass: false, detail: "parse.js not created" };
      const r = await node(dir, "parse.js");
      if (!r.ok) return { pass: false, detail: `run failed: ${r.out.slice(0, 80)}` };
      return /\b142\b/.test(r.out)
        ? { pass: true, detail: "prints 142" }
        : { pass: false, detail: `printed ${JSON.stringify(r.out)}` };
    },
  },
  {
    id: "dep-version-lookup",
    title: "Find a dependency version in a larger tree",
    tags: ["retrieve", "read"],
    async setup(dir) {
      // Noise files so the answer isn't trivially the only file.
      for (let i = 0; i < 8; i++) {
        await write(dir, `src/module${i}.js`, `export function f${i}() { return ${i}; }\n`);
      }
      await write(
        dir,
        "package.json",
        JSON.stringify(
          {
            name: "widget",
            version: "1.0.0",
            dependencies: { "left-pad": "1.3.0", chalk: "5.3.0" },
          },
          null,
          2,
        ) + "\n",
      );
    },
    prompt:
      "What version of the 'left-pad' dependency does this project declare? Answer with just the version string.",
    async check(_dir, finalText) {
      return /1\.3\.0/.test(finalText)
        ? { pass: true, detail: "answered 1.3.0" }
        : { pass: false, detail: `did not answer 1.3.0: ${finalText.slice(0, 80)}` };
    },
  },
  {
    // Distilled from a real scissor session (see `scissor eval-gen`): probes
    // correct RFC-4180 quoting and a lossless round trip, not just "a file exists".
    id: "json-csv-roundtrip",
    title: "Build a JSON<->CSV converter with correct quoting",
    tags: ["write", "reason", "multi-step", "shell"],
    prompt:
      "Create convert.js (CommonJS, dependency-free) exporting two functions. " +
      "jsonToCsv(records): records is an array of flat objects with string values; " +
      "return an RFC-4180 CSV string whose header row is the keys of the first record, " +
      "quoting any field containing a comma, double quote, or newline, and doubling " +
      "embedded double quotes. csvToJson(text): parse such CSV back into an array of " +
      "objects (string values). A json->csv->json round trip must return the original " +
      "records. Verify it works.",
    async check(dir) {
      if (!(await exists(dir, "convert.js"))) return { pass: false, detail: "convert.js not created" };
      const probe = [
        "const { jsonToCsv, csvToJson } = require('./convert.js');",
        "const recs = [{ name: 'Alice, Jr.', note: 'she said \"hi\"' }, { name: 'Bob', note: 'plain' }];",
        "const csv = jsonToCsv(recs);",
        "if (!csv.includes('\"Alice, Jr.\"')) throw new Error('comma field not quoted');",
        "if (!csv.includes('\"she said \"\"hi\"\"\"')) throw new Error('embedded quote not doubled');",
        "const back = csvToJson(csv).filter((r) => r && r.name);",
        "if (back.length !== 2) throw new Error('expected 2 rows, got ' + back.length);",
        "if (back[0].name !== 'Alice, Jr.' || back[0].note !== 'she said \"hi\"') throw new Error('row0 mismatch: ' + JSON.stringify(back[0]));",
        "if (back[1].name !== 'Bob' || back[1].note !== 'plain') throw new Error('row1 mismatch: ' + JSON.stringify(back[1]));",
        "console.log('OK');",
        "",
      ].join("\n");
      await write(dir, "__probe.js", probe);
      const r = await node(dir, "__probe.js");
      if (!r.ok) return { pass: false, detail: `round trip failed: ${r.out.slice(0, 120)}` };
      return r.out.includes("OK")
        ? { pass: true, detail: "RFC-4180 quoting + lossless round trip" }
        : { pass: false, detail: `probe output: ${JSON.stringify(r.out.slice(0, 80))}` };
    },
  },
  {
    // Exercises the checker-feedback -> fix loop that the `diagnostics` tool
    // enables: the project ships a `typecheck` script that emits a tsc-style
    // diagnostic until the bug is fixed. The agent should surface it (via
    // `diagnostics`) and repair the source so the check passes.
    id: "type-error-fix",
    title: "Use the checker to locate and fix a defect",
    tags: ["read", "edit", "shell", "debug", "diagnostics"],
    async setup(dir) {
      await write(
        dir,
        "area.js",
        "// A rectangle's area. Keep this a CommonJS module exporting `area`.\n" +
          "function area(w, h) {\n  return w + h; // BUG: area should multiply, not add\n}\nmodule.exports = { area };\n",
      );
      await write(
        dir,
        "check.js",
        [
          "const { area } = require('./area.js');",
          "const cases = [[3, 4, 12], [2, 5, 10]];",
          "for (const [w, h, exp] of cases) {",
          "  const got = area(w, h);",
          "  if (got !== exp) {",
          "    console.log(`area.js(3,10): error TS9001: area(${w},${h}) returned ${got}, expected ${exp}`);",
          "    process.exit(1);",
          "  }",
          "}",
          "console.log('typecheck ok');",
          "",
        ].join("\n"),
      );
      await write(
        dir,
        "package.json",
        JSON.stringify({ name: "geo", scripts: { typecheck: "node check.js" } }, null, 2) + "\n",
      );
    },
    prompt:
      "The project's check (`npm run typecheck`) fails. Use the `diagnostics` tool to see the reported error, then fix the arithmetic bug in area.js so the check passes. Keep area.js a CommonJS module that exports `area` (do not rename or move the file); do not edit check.js or package.json.",
    async check(dir) {
      if (!(await exists(dir, "area.js"))) return { pass: false, detail: "area.js is missing" };
      const r = await node(dir, "check.js");
      if (!r.ok) return { pass: false, detail: `check still fails: ${r.out.slice(0, 100)}` };
      if (!r.out.includes("typecheck ok")) {
        return { pass: false, detail: `unexpected check output: ${JSON.stringify(r.out.slice(0, 80))}` };
      }
      const src = await read(dir, "area.js");
      if (/\bw\s*\+\s*h\b/.test(src)) return { pass: false, detail: "area.js still adds instead of multiplies" };
      return { pass: true, detail: "checker passes (area fixed)" };
    },
  },
];
