/**
 * The replay scenario: a small project with a real bug, plus the assistant
 * turns that fix it.
 *
 * Only the model's side of the conversation is scripted. The tool calls below
 * are executed for real by the ordinary agent loop, against a real temporary
 * workspace — `run_shell` really spawns node, `edit_file` really goes through
 * the edit engine, and the test really fails before the fix and passes after.
 * That is the whole point: everything except the model's reasoning is genuine,
 * and the demo must say so rather than implying live inference.
 *
 * The bug is a classic off-by-design median: taking the upper-middle element
 * instead of averaging the two middle values, so it is correct for odd-length
 * input and silently wrong for even-length input.
 */
import type { ChatResult } from "@scissor/core";
import { promises as fs } from "node:fs";
import path from "node:path";

/** The request the "user" makes in the replay. */
export const DEMO_TASK = "The stats test is failing. Find the bug and fix it.";

/** Buggy source the replay starts from. */
export const BUGGY_MEDIAN = `export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}`;

/** The corrected implementation the replay lands on. */
export const FIXED_MEDIAN = `export function median(values) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}`;

const STATS_SRC = `/** Small statistics helpers. */

export function mean(values) {
  if (values.length === 0) return NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

${BUGGY_MEDIAN}
`;

const STATS_TEST = `import assert from "node:assert/strict";
import { mean, median } from "../src/stats.js";

assert.equal(mean([1, 2, 3, 4]), 2.5);
assert.equal(median([3, 1, 2]), 2);
assert.equal(
  median([1, 2, 3, 4]),
  2.5,
  "median of an even-length list is the mean of the two middle values",
);

console.log("stats: all tests passed");
`;

const PACKAGE_JSON = `{
  "name": "stats-demo",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node test/stats.test.js"
  }
}
`;

const README = `# stats-demo

Tiny statistics helpers used by the scissor replay demo.

Run the tests with \`node test/stats.test.js\`.
`;

/** The command the agent runs to see the failure and confirm the fix. */
export const DEMO_TEST_COMMAND = "node test/stats.test.js";

/** Files the replay workspace starts with, as workspace-relative paths. */
export const DEMO_FILES: Record<string, string> = {
  "package.json": PACKAGE_JSON,
  "README.md": README,
  "src/stats.js": STATS_SRC,
  "test/stats.test.js": STATS_TEST,
};

/** Materialize the starting workspace. */
export async function seedDemoWorkspace(root: string): Promise<void> {
  for (const [rel, content] of Object.entries(DEMO_FILES)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }
}

let counter = 0;
function call(name: string, args: Record<string, unknown>): ChatResult {
  counter += 1;
  return { text: "", toolCalls: [{ id: `demo-${counter}`, name, arguments: args }] };
}

/**
 * The scripted assistant turns, in order. The shape mirrors how the agent
 * actually works on this kind of task: plan, locate, read, reproduce, fix,
 * re-run, report.
 */
export const DEMO_SCRIPT: ChatResult[] = [
  call("present_plan", {
    summary: "Find why the stats test fails and fix the underlying bug.",
    steps: [
      "Locate the statistics code and the failing test",
      "Run the test to see the actual failure",
      "Fix the faulty implementation",
      "Re-run the test to confirm it passes",
    ],
  }),
  call("retrieve", { query: "median calculation", queries: ["median", "statistics helpers"] }),
  call("read_file", { path: "src/stats.js" }),
  call("run_shell", { command: DEMO_TEST_COMMAND, block_until_ms: 20000 }),
  call("edit_file", {
    path: "src/stats.js",
    old_string: BUGGY_MEDIAN,
    new_string: FIXED_MEDIAN,
  }),
  call("run_shell", { command: DEMO_TEST_COMMAND, block_until_ms: 20000 }),
  {
    text:
      "Fixed `median` in `src/stats.js`.\n\n" +
      "The implementation returned `sorted[floor(n/2)]` unconditionally, which is the " +
      "upper-middle element. That is correct for odd-length input, so the bug stayed " +
      "hidden, but for even-length input the median is the mean of the two middle " +
      "values — `median([1,2,3,4])` returned 3 instead of 2.5.\n\n" +
      "It now averages the two middle values when the length is even, and returns NaN " +
      "for empty input to match `mean`. `node test/stats.test.js` passes.",
    toolCalls: [],
  },
];

/** Expected tool sequence, exported so the test can pin the trajectory. */
export const DEMO_TOOL_SEQUENCE = [
  "present_plan",
  "retrieve",
  "read_file",
  "run_shell",
  "edit_file",
  "run_shell",
] as const;
