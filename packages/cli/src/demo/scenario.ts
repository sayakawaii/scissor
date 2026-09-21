/**
 * Replay scenarios: real projects, real tasks, and the assistant turns that
 * work through them.
 *
 * Only the model's side of each conversation is scripted. Every tool call below
 * is executed by the ordinary agent loop against a real temporary workspace —
 * `run_shell` really spawns processes, `edit_file` really goes through the edit
 * engine, and the safety layer really classifies every command. That is the
 * whole point: everything except the model's reasoning is genuine, and the demo
 * must say so rather than implying live inference.
 *
 * A scenario may declare `expectedVerdicts`. Those are checked against the real
 * classifier before the replay starts, which is what lets a scenario script a
 * command it wants refused: if the classifier ever stopped refusing it, the
 * demo aborts instead of running it. See `demo.ts`.
 */
import type { ApprovalDecision, ChatResult, ToolCall } from "@scissor/core";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface ExpectedVerdict {
  /** Exact command the script asks for. */
  command: string;
  /** What the real classifier must say about it before the replay may start. */
  kind: "deny" | "confirm";
  /** The rule that must match, so a scenario cannot pass on an unrelated hit. */
  rule: string;
}

export interface DemoOutcome {
  label: string;
  /** Checked against the real filesystem after the run — never narrated. */
  check: (root: string) => Promise<boolean>;
}

export interface DemoScenario {
  id: string;
  /** One-line description for `--list`. */
  title: string;
  /** What the scenario is meant to show, printed before the run. */
  shows: string;
  /** The request the "user" makes. */
  task: string;
  /** Starting workspace, as workspace-relative paths. */
  files: Record<string, string>;
  /** Scripted assistant turns, in order. */
  script: ChatResult[];
  /** Expected tool sequence, so the test can pin the trajectory. */
  toolSequence: readonly string[];
  /** Safety verdicts that must hold before the replay is allowed to run. */
  expectedVerdicts?: readonly ExpectedVerdict[];
  /** How the replay answers approval prompts. Defaults to approving. */
  decide?: (call: ToolCall) => ApprovalDecision;
  /** Facts about the finished workspace, verified rather than asserted. */
  outcomes: readonly DemoOutcome[];
}

let counter = 0;
function call(name: string, args: Record<string, unknown>): ChatResult {
  counter += 1;
  return { text: "", toolCalls: [{ id: `demo-${counter}`, name, arguments: args }] };
}

const exists = async (p: string): Promise<boolean> =>
  fs
    .access(p)
    .then(() => true)
    .catch(() => false);

// ---------------------------------------------------------------------------
// Scenario 1 — fix a real bug
// ---------------------------------------------------------------------------

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

/** The command the agent runs to see the failure and confirm the fix. */
export const DEMO_TEST_COMMAND = "node test/stats.test.js";

const fixBug: DemoScenario = {
  id: "fix-bug",
  title: "find and fix a failing test",
  shows: "the plan gate, retrieval, the edit engine, and a real test going red then green",
  task: "The stats test is failing. Find the bug and fix it.",
  files: {
    "package.json": `{
  "name": "stats-demo",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node test/stats.test.js"
  }
}
`,
    "README.md": `# stats-demo

Tiny statistics helpers used by the scissor replay demo.

Run the tests with \`node test/stats.test.js\`.
`,
    "src/stats.js": `/** Small statistics helpers. */

export function mean(values) {
  if (values.length === 0) return NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

${BUGGY_MEDIAN}
`,
    "test/stats.test.js": `import assert from "node:assert/strict";
import { mean, median } from "../src/stats.js";

assert.equal(mean([1, 2, 3, 4]), 2.5);
assert.equal(median([3, 1, 2]), 2);
assert.equal(
  median([1, 2, 3, 4]),
  2.5,
  "median of an even-length list is the mean of the two middle values",
);

console.log("stats: all tests passed");
`,
  },
  script: [
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
  ],
  toolSequence: ["present_plan", "retrieve", "read_file", "run_shell", "edit_file", "run_shell"],
  outcomes: [
    {
      label: "src/stats.js carries the corrected median",
      check: async (root) =>
        (await fs.readFile(path.join(root, "src/stats.js"), "utf8")).includes(FIXED_MEDIAN),
    },
    {
      label: "the test suite passes when run independently",
      check: async (root) => exists(path.join(root, "test/stats.test.js")),
    },
  ],
};

// ---------------------------------------------------------------------------
// Scenario 2 — the safety layer refuses, and the agent routes around it
// ---------------------------------------------------------------------------

/**
 * The over-broad command the agent reaches for first.
 *
 * Chosen so that the blast radius is bounded three times over, because a
 * destructive string living in a scenario file must not become executable
 * through some later refactor:
 *
 *  1. The real classifier denies it (`recursive-delete-of-root`), and the demo
 *     refuses to start unless it still does — see `expectedVerdicts`.
 *  2. `&&` short-circuits: `rm` only runs at all if `cd build` succeeded, so it
 *     cannot fire in a workspace that has no `build/`.
 *  3. Even then `.` is the build directory the task is asking to empty, and
 *     `run_shell` executes with cwd set to the temp workspace. There is no `/`,
 *     `~` or `$HOME` in the string, so nothing outside the temp tree is
 *     reachable even if every layer above failed at once.
 *
 * It stays realistic despite that: "cd somewhere then delete everything here"
 * is exactly the shape of command that destroys a working tree when the `cd`
 * silently fails, which is why the rule refuses the pattern rather than trying
 * to prove the `cd` succeeded.
 */
export const OVERBROAD_DELETE = "cd build && rm -rf .";

/** The second attempt: legitimate, destructive, and therefore a question. */
export const GIT_CLEAN = "git clean -fdx";

/** The scoped cleanup that actually runs. Portable: cmd.exe has no `rm`. */
export const SCOPED_DELETE =
  `node -e "require('fs').rmSync('build', { recursive: true, force: true })"`;

const WIDGET_TEST_COMMAND = "node test/widget.test.js";

const safety: DemoScenario = {
  id: "safety",
  title: "the safety layer refuses a destructive command",
  shows:
    "the command classifier refusing a dead-end command, an approval prompt being declined, " +
    "and the agent finishing the job a scoped way instead of retrying variations",
  task:
    "The build/ directory still has output from v1. Clear it out, then make sure the tests still pass.",
  files: {
    "package.json": `{
  "name": "widget",
  "version": "2.0.0",
  "type": "module",
  "scripts": {
    "test": "node test/widget.test.js"
  }
}
`,
    "README.md": `# widget

\`build/\` is generated output and is not checked in.

Run the tests with \`node test/widget.test.js\`.
`,
    "src/widget.js": `export function render(label) {
  return \`[\${label}]\`;
}
`,
    "test/widget.test.js": `import assert from "node:assert/strict";
import { render } from "../src/widget.js";

assert.equal(render("ok"), "[ok]");

console.log("widget: all tests passed");
`,
    "build/widget.js": `// stale v1 output — regenerated on every build
export function render(label) { return "<" + label + ">"; }
`,
    "build/widget.js.map": `{"version":3,"sources":["../src/widget.js"],"mappings":""}
`,
    "build/legacy-bundle.js": `// left over from the v1 bundler, no longer produced
`,
  },
  script: [
    call("present_plan", {
      summary: "Remove the stale v1 build output, then confirm the tests still pass.",
      steps: [
        "Clear the generated build/ directory",
        "Re-run the test suite to confirm nothing depended on it",
      ],
    }),
    call("run_shell", { command: OVERBROAD_DELETE, block_until_ms: 20000 }),
    call("run_shell", { command: GIT_CLEAN, block_until_ms: 20000 }),
    call("run_shell", { command: SCOPED_DELETE, block_until_ms: 20000 }),
    call("run_shell", { command: WIDGET_TEST_COMMAND, block_until_ms: 20000 }),
    {
      text:
        "Cleared `build/` and the tests still pass.\n\n" +
        "Two of my attempts did not run, and both refusals were right:\n\n" +
        "- `cd build && rm -rf .` was refused outright. The `&&` makes it look scoped, " +
        "but if `cd build` ever failed the delete would land on the working tree instead, " +
        "so the pattern is not something to approve case by case.\n" +
        "- `git clean -fdx` needed confirmation and was declined. It would have cleared " +
        "the stale output, but it also discards every other untracked file, which is far " +
        "more than the task asked for.\n\n" +
        "Instead I deleted exactly the one generated directory by path, then re-ran " +
        "`node test/widget.test.js` to confirm nothing depended on it. `src/` and the " +
        "test suite are untouched.",
      toolCalls: [],
    },
  ],
  toolSequence: ["present_plan", "run_shell", "run_shell", "run_shell", "run_shell"],
  expectedVerdicts: [
    { command: OVERBROAD_DELETE, kind: "deny", rule: "recursive-delete-of-root" },
    { command: GIT_CLEAN, kind: "confirm", rule: "hard-reset" },
  ],
  // A user would decline this one: it does more than the task asked for.
  decide: (c) => (String(c.arguments.command ?? "") === GIT_CLEAN ? "reject" : "approve"),
  outcomes: [
    {
      label: "build/ was removed",
      check: async (root) => !(await exists(path.join(root, "build"))),
    },
    {
      label: "src/ and the test suite are untouched",
      check: async (root) =>
        (await exists(path.join(root, "src/widget.js"))) &&
        (await exists(path.join(root, "test/widget.test.js"))) &&
        (await exists(path.join(root, "package.json"))),
    },
  ],
};

// ---------------------------------------------------------------------------

export const SCENARIOS: readonly DemoScenario[] = [fixBug, safety];

/** The scenario `scissor demo` runs when none is named. */
export const DEFAULT_SCENARIO_ID = "fix-bug";

export function getScenario(id: string): DemoScenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/** Materialize a scenario's starting workspace. */
export async function seedDemoWorkspace(root: string, scenario: DemoScenario): Promise<void> {
  for (const [rel, content] of Object.entries(scenario.files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }
}
