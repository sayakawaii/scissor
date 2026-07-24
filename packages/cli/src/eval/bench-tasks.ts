import { exists, read, runNode, write } from "./task-helpers.js";
import { IOP_TASKS } from "./iop-tasks.js";
import { GO_TASKS } from "./go-tasks.js";
import { EVAL_TASKS, type EvalTask } from "./tasks.js";

// Bench tasks allow a slightly longer per-run budget than the quick eval suite.
const node = (dir: string, cmd: string) => runNode(dir, cmd, 25_000);

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
  {
    // Option D (OPEN_ITEMS §7d): a real-codebase-flavored task — the defect is
    // one function buried in a larger, multi-directory tree with same-topic red
    // herrings, so *locating* it (repo-map / retrieve) matters, not just editing.
    // A near-naked harness must blindly grep/read many files; scaffolding should
    // find it in fewer turns/tokens. Behavior is checked over several varied
    // cases so a hardcoded return can't pass.
    id: "buried-bug-fix",
    title: "Find and fix a bug buried in a larger project tree",
    tags: ["retrieve", "read", "edit", "debug", "multi-file", "real"],
    timeoutMs: 240_000,
    oracle: { files: 1 },
    async setup(dir) {
      // Noise modules across several directories so the tree looks real and the
      // target isn't the only file.
      const areas = ["utils", "models", "handlers", "services", "lib"];
      for (const area of areas) {
        for (let i = 0; i < 5; i++) {
          await write(
            dir,
            `src/${area}/${area}${i}.js`,
            `// ${area} helper ${i}\nfunction ${area}${i}(x) {\n  return x + ${i};\n}\nmodule.exports = { ${area}${i} };\n`,
          );
        }
      }
      // Same-topic red herrings: mention "discount" but are NOT the buggy code.
      await write(
        dir,
        "src/models/discountRecord.js",
        "// Data model for a stored discount; no calculation happens here.\n" +
          "function makeDiscountRecord(code, pct) {\n  return { code, pct, createdAt: 0 };\n}\nmodule.exports = { makeDiscountRecord };\n",
      );
      await write(
        dir,
        "src/utils/formatDiscount.js",
        "// Formats a discount percentage for display only.\n" +
          "function formatDiscount(pct) {\n  return `${pct}% off`;\n}\nmodule.exports = { formatDiscount };\n",
      );
      // The real chain the check exercises. The bug is in discount.js.
      await write(
        dir,
        "src/services/pricing/discount.js",
        "// Apply a percentage discount to a price and return the new price.\n" +
          "function applyDiscount(price, pct) {\n  return price - pct; // BUG: subtracts pct as an absolute amount, not a percentage\n}\nmodule.exports = { applyDiscount };\n",
      );
      await write(
        dir,
        "src/services/pricing/index.js",
        "const { applyDiscount } = require('./discount.js');\nmodule.exports = { applyDiscount };\n",
      );
      await write(
        dir,
        "check.js",
        [
          "const { applyDiscount } = require('./src/services/pricing');",
          "const cases = [[200, 10, 180], [50, 50, 25], [99, 0, 99], [100, 100, 0], [80, 25, 60]];",
          "for (const [price, pct, exp] of cases) {",
          "  const got = applyDiscount(price, pct);",
          "  if (got !== exp) {",
          "    console.error(`FAIL: applyDiscount(${price}, ${pct}) = ${got}, expected ${exp}`);",
          "    process.exit(1);",
          "  }",
          "}",
          "console.log('OK');",
          "",
        ].join("\n"),
      );
    },
    prompt:
      "Running `node check.js` fails: applyDiscount returns the wrong amount. The function lives somewhere under src/ in this project (which has many modules). Locate the offending function and fix it so `node check.js` prints OK. A percentage discount means the price is reduced by that percentage (e.g. a 10% discount on 200 is 180). Do not edit check.js.",
    async check(dir) {
      const r = await node(dir, "check.js");
      if (!r.ok) return { pass: false, detail: `check still fails: ${r.out.slice(0, 100)}` };
      if (!r.out.includes("OK")) {
        return { pass: false, detail: `unexpected check output: ${JSON.stringify(r.out.slice(0, 80))}` };
      }
      // Guard against editing check.js instead of fixing the source.
      const src = await read(dir, "src/services/pricing/discount.js");
      if (/return\s+price\s*-\s*pct\b/.test(src)) {
        return { pass: false, detail: "discount.js still subtracts pct as an absolute amount" };
      }
      return { pass: true, detail: "located and fixed applyDiscount; check passes" };
    },
  },
  {
    // Option D, harder tier: a bigger (~50-file) tree AND a *subtle* correctness
    // bug — median of an even-length list must average the two middle values,
    // but the code returns the upper-middle element. Odd-length inputs pass, so
    // grepping/eyeballing isn't enough; the fix needs edge-case reasoning. Scored
    // by an independent probe (not the on-disk check.js), so neutering check.js
    // can't pass it.
    id: "deep-median-bug",
    title: "Fix a subtle even-length median bug in a large tree",
    tags: ["retrieve", "read", "edit", "debug", "multi-file", "reason", "real"],
    timeoutMs: 300_000,
    oracle: { files: 1 },
    async setup(dir) {
      const areas = ["core", "services", "utils", "models", "handlers", "adapters"];
      for (const area of areas) {
        for (let i = 0; i < 8; i++) {
          await write(
            dir,
            `src/${area}/${area}${i}.js`,
            `// ${area} unit ${i}\nfunction ${area}${i}(x) {\n  return x * ${i + 1};\n}\nmodule.exports = { ${area}${i} };\n`,
          );
        }
      }
      // Same-topic red herrings: other statistics that are correct.
      await write(
        dir,
        "src/analytics/mean.js",
        "function mean(nums) {\n  if (nums.length === 0) return 0;\n  return nums.reduce((a, b) => a + b, 0) / nums.length;\n}\nmodule.exports = { mean };\n",
      );
      await write(
        dir,
        "src/analytics/mode.js",
        "function mode(nums) {\n  const c = new Map();\n  let best = nums[0], bestN = 0;\n  for (const n of nums) { const k = (c.get(n) || 0) + 1; c.set(n, k); if (k > bestN) { bestN = k; best = n; } }\n  return best;\n}\nmodule.exports = { mode };\n",
      );
      // The buggy function, buried a couple of directories deep.
      await write(
        dir,
        "src/analytics/summary/median.js",
        "// Return the median of a list of numbers.\n" +
          "function median(nums) {\n" +
          "  const s = [...nums].sort((a, b) => a - b);\n" +
          "  const mid = Math.floor(s.length / 2);\n" +
          "  return s[mid]; // BUG: for even-length input, average s[mid - 1] and s[mid]\n" +
          "}\n" +
          "module.exports = { median };\n",
      );
      await write(
        dir,
        "src/analytics/summary/index.js",
        "const { median } = require('./median.js');\nmodule.exports = { median };\n",
      );
      await write(
        dir,
        "check.js",
        [
          "const { median } = require('./src/analytics/summary');",
          "const cases = [[[3, 1, 2], 2], [[1, 2, 3, 4], 2.5], [[10, 20, 30, 40, 50, 60], 35]];",
          "for (const [nums, exp] of cases) {",
          "  const got = median(nums);",
          "  if (got !== exp) {",
          "    console.error(`FAIL: median(${JSON.stringify(nums)}) = ${got}, expected ${exp}`);",
          "    process.exit(1);",
          "  }",
          "}",
          "console.log('OK');",
          "",
        ].join("\n"),
      );
    },
    prompt:
      "Running `node check.js` fails. Somewhere under src/ a statistics function returns the wrong value for some inputs. Find the offending function and fix it so `node check.js` prints OK. Note: the median of an even-length list is the average of its two middle values. Do not edit check.js.",
    async check(dir) {
      // Score with our own probe so editing check.js can't help.
      const probe = [
        "const { median } = require('./src/analytics/summary');",
        "const cases = [",
        "  [[3, 1, 2], 2],",
        "  [[5], 5],",
        "  [[1, 2, 3, 4], 2.5],",
        "  [[10, 20, 30, 40, 50, 60], 35],",
        "  [[4, 1, 3, 2, 6, 5], 3.5],",
        "  [[7, 7, 8, 9], 7.5],",
        "];",
        "for (const [nums, exp] of cases) {",
        "  const got = median(nums);",
        "  if (Math.abs(got - exp) > 1e-9) throw new Error(`median(${JSON.stringify(nums)})=${got}, expected ${exp}`);",
        "}",
        "console.log('OK');",
        "",
      ].join("\n");
      await write(dir, "__probe_median.js", probe);
      const r = await node(dir, "__probe_median.js");
      if (!r.ok) return { pass: false, detail: `median still wrong: ${r.out.slice(0, 120)}` };
      return r.out.includes("OK")
        ? { pass: true, detail: "even-length median fixed (probe passes)" }
        : { pass: false, detail: `probe output: ${JSON.stringify(r.out.slice(0, 80))}` };
    },
  },
  {
    // Option D, grounded in REAL code (Scheme D): ported from the iop-toolkit
    // backend's `service/omcianalyzer/omciSchema/util.go`. There, most widths
    // decode via `binary.BigEndian`, but the 40-bit path (`Uint40`) is
    // hand-rolled with explicit shifts — exactly the kind of code that invites an
    // off-by-8. Here the 5-byte decoder scales the most-significant byte by 2**24
    // instead of 2**32, so it's only wrong once b[0] != 0 (value >= 2**32). All
    // the standard widths (1/2/4/8) and small 5-byte values decode correctly, so
    // grep/eyeball isn't enough — the fix needs range/edge reasoning. Buried in an
    // omci-flavoured tree with correct look-alike decoders as red herrings, and
    // probe-scored so neutering check.js can't pass it. (JS bit-shifts are 32-bit,
    // so widths >32 use arithmetic — values stay < 2**53.)
    id: "omci-uint40-decode-bug",
    title: "Fix a subtle big-endian 40-bit decode bug in a real-flavoured tree",
    tags: ["retrieve", "read", "edit", "debug", "multi-file", "reason", "real"],
    timeoutMs: 300_000,
    oracle: { files: 1 },
    async setup(dir) {
      // Noise mirroring the real backend layout, so *locating* the decoder matters.
      const areas = [
        "controller",
        "dao",
        "routers",
        "models",
        "middleware",
        "metrics",
        "service/omcianalyzer/omciDiagram",
        "service/omciDeshape",
      ];
      for (const area of areas) {
        for (let i = 0; i < 5; i++) {
          const name = (area.split("/").pop() ?? area) + String(i);
          await write(
            dir,
            `src/${area}/${name}.js`,
            `// ${area} unit ${i}\nfunction ${name}(x) {\n  return x + ${i};\n}\nmodule.exports = { ${name} };\n`,
          );
        }
      }
      // Same-topic red herrings: correct decoders that look like the target.
      await write(
        dir,
        "src/service/omcianalyzer/omciSchema/bigendian.js",
        "// Correct fixed-width big-endian helpers (do not touch).\n" +
          "function bytesUint16(b) {\n  return b[0] * 256 + b[1];\n}\n" +
          "function bytesUint32(b) {\n  return b[0] * 2 ** 24 + b[1] * 2 ** 16 + b[2] * 2 ** 8 + b[3];\n}\n" +
          "module.exports = { bytesUint16, bytesUint32 };\n",
      );
      // The buggy hand-rolled 40-bit decoder, buried a few directories deep.
      await write(
        dir,
        "src/service/omcianalyzer/omciSchema/util.js",
        [
          "// Variable-width big-endian unsigned decode (ported from omciSchema/util.go).",
          "function uint40(b) {",
          "  // BUG: the most-significant byte must scale by 2**32, not 2**24.",
          "  return b[0] * 2 ** 24 + b[1] * 2 ** 24 + b[2] * 2 ** 16 + b[3] * 2 ** 8 + b[4];",
          "}",
          "function uint64be(b) {",
          "  let v = 0;",
          "  for (let i = 0; i < 8; i++) v = v * 256 + b[i];",
          "  return v;",
          "}",
          "function bytesUInteger(bytes, size) {",
          "  if (size === 1) return bytes[0];",
          "  if (size === 2) return bytes[0] * 256 + bytes[1];",
          "  if (size === 4) return bytes[0] * 2 ** 24 + bytes[1] * 2 ** 16 + bytes[2] * 2 ** 8 + bytes[3];",
          "  if (size === 5) return uint40(bytes);",
          "  return uint64be(bytes);",
          "}",
          "module.exports = { bytesUInteger, uint40 };",
          "",
        ].join("\n"),
      );
      await write(
        dir,
        "src/service/omcianalyzer/omciSchema/index.js",
        "const { bytesUInteger } = require('./util.js');\nmodule.exports = { bytesUInteger };\n",
      );
      await write(
        dir,
        "check.js",
        [
          "const { bytesUInteger } = require('./src/service/omcianalyzer/omciSchema');",
          "const cases = [",
          "  [[7], 1, 7],",
          "  [[1, 0], 2, 256],",
          "  [[0, 0, 1, 0], 4, 256],",
          "  [[1, 0, 0, 0, 0], 5, 4294967296],",
          "  [[255, 255, 255, 255, 255], 5, 1099511627775],",
          "];",
          "for (const [bytes, size, exp] of cases) {",
          "  const got = bytesUInteger(bytes, size);",
          "  if (got !== exp) {",
          "    console.error(`FAIL: bytesUInteger(${JSON.stringify(bytes)}, ${size}) = ${got}, expected ${exp}`);",
          "    process.exit(1);",
          "  }",
          "}",
          "console.log('OK');",
          "",
        ].join("\n"),
      );
    },
    prompt:
      "Running `node check.js` fails: a big-endian byte-to-integer decoder under src/ returns the wrong value for some inputs (this project has many modules). Find the offending function and fix it so `node check.js` prints OK. The decoder reads big-endian unsigned integers of a given byte width; the 5-byte (40-bit) width is wrong for larger values. Do not edit check.js.",
    async check(dir) {
      // Independent probe (not the on-disk check.js): standard widths, plus
      // 5-byte values spanning b[0]==0 (the trap) through the full 2**40-1 range.
      const probe = [
        "const { bytesUInteger } = require('./src/service/omcianalyzer/omciSchema');",
        "const cases = [",
        "  [[7], 1, 7],",
        "  [[1, 0], 2, 256],",
        "  [[0, 0, 1, 0], 4, 256],",
        "  [[0, 0, 0, 0, 0, 0, 1, 0], 8, 256],",
        "  [[0, 1, 0, 0, 0], 5, 16777216],",
        "  [[1, 0, 0, 0, 0], 5, 4294967296],",
        "  [[1, 2, 3, 4, 5], 5, 4328719365],",
        "  [[255, 255, 255, 255, 255], 5, 1099511627775],",
        "];",
        "for (const [bytes, size, exp] of cases) {",
        "  const got = bytesUInteger(bytes, size);",
        "  if (got !== exp) throw new Error(`bytesUInteger(${JSON.stringify(bytes)}, ${size})=${got}, expected ${exp}`);",
        "}",
        "console.log('OK');",
        "",
      ].join("\n");
      await write(dir, "__probe_uint40.js", probe);
      const r = await node(dir, "__probe_uint40.js");
      if (!r.ok) return { pass: false, detail: `decode still wrong: ${r.out.slice(0, 120)}` };
      if (!r.out.includes("OK")) {
        return { pass: false, detail: `probe output: ${JSON.stringify(r.out.slice(0, 80))}` };
      }
      // Guard: the fix must live in the decoder, not a hardcoded lookup — the
      // function must still derive its result from the input bytes.
      const src = await read(dir, "src/service/omcianalyzer/omciSchema/util.js");
      if (!/b\[0\]/.test(src) || !/b\[4\]/.test(src)) {
        return { pass: false, detail: "uint40 no longer decodes from its input bytes (likely hardcoded)" };
      }
      return { pass: true, detail: "40-bit big-endian decode fixed (probe passes)" };
    },
  },
];

/**
 * Resolve task ids across BOTH the quick eval suite and the harder bench suite.
 * With no ids, returns the eval suite (unchanged default for `scissor eval`);
 * with ids, an id may name an eval OR a bench task — so comparison commands
 * (`ab`, `ablate`) can target harder tasks like `buried-bug-fix`.
 */
export function resolveTasks(ids?: string[]): EvalTask[] {
  if (!ids || ids.length === 0) return EVAL_TASKS;
  const set = new Set(ids);
  // IOP_TASKS (external source tree) and GO_TASKS (Go toolchain) are only ever
  // returned when explicitly named by id — never part of the default (hermetic)
  // suite / pre-push gate.
  return [...EVAL_TASKS, ...BENCH_TASKS, ...IOP_TASKS, ...GO_TASKS].filter((t) => set.has(t.id));
}
