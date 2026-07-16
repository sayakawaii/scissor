import { exists as fileExists, read as readFile, runNode, write } from "./task-helpers.js";

export interface EvalCheckResult {
  pass: boolean;
  detail: string;
}

export interface EvalTask {
  id: string;
  title: string;
  /** What capability this exercises, for the report. */
  tags: string[];
  prompt: string;
  /** Populate the temp workspace before the agent runs. */
  setup?: (dir: string) => Promise<void>;
  /** Score the result. `finalText` is the agent's last message. */
  check: (dir: string, finalText: string) => Promise<EvalCheckResult>;
  timeoutMs?: number;
}

export const EVAL_TASKS: EvalTask[] = [
  {
    id: "create-file",
    title: "Create a file with exact contents",
    tags: ["write"],
    prompt:
      "Create a file named hello.txt whose entire contents are exactly this line: Hello, scissor!",
    async check(dir) {
      if (!(await fileExists(dir, "hello.txt"))) {
        return { pass: false, detail: "hello.txt was not created" };
      }
      const content = (await readFile(dir, "hello.txt")).trim();
      return content === "Hello, scissor!"
        ? { pass: true, detail: "exact contents match" }
        : { pass: false, detail: `unexpected contents: ${JSON.stringify(content.slice(0, 60))}` };
    },
  },
  {
    id: "edit-json",
    title: "Edit one field in JSON, preserve the rest",
    tags: ["edit"],
    async setup(dir) {
      await write(
        dir,
        "config.json",
        JSON.stringify({ name: "demo", debug: false, retries: 3 }, null, 2) + "\n",
      );
    },
    prompt:
      'In config.json, change the "debug" field to true. Do not change any other field.',
    async check(dir) {
      let parsed: { name?: string; debug?: unknown; retries?: number };
      try {
        parsed = JSON.parse(await readFile(dir, "config.json"));
      } catch (e) {
        return { pass: false, detail: `config.json no longer valid JSON: ${(e as Error).message}` };
      }
      if (parsed.debug !== true) return { pass: false, detail: `debug is ${String(parsed.debug)}, expected true` };
      if (parsed.name !== "demo" || parsed.retries !== 3) {
        return { pass: false, detail: "other fields were altered" };
      }
      return { pass: true, detail: "debug=true, other fields intact" };
    },
  },
  {
    id: "compute-shell",
    title: "Write a script that computes a value",
    tags: ["write", "shell"],
    prompt:
      "Create a Node.js script named sum.js that prints the sum of 2 and 3 (i.e. the number 5) to stdout, and nothing else. You may run it to verify.",
    async check(dir) {
      if (!(await fileExists(dir, "sum.js"))) return { pass: false, detail: "sum.js not created" };
      const { ok, out } = await runNode(dir, "sum.js");
      if (!ok) return { pass: false, detail: `sum.js failed to run: ${out.slice(0, 80)}` };
      return out === "5" ? { pass: true, detail: "prints 5" } : { pass: false, detail: `printed ${JSON.stringify(out)}` };
    },
  },
  {
    id: "rename-refactor",
    title: "Rename a function across a file",
    tags: ["edit", "multi-step"],
    async setup(dir) {
      await write(
        dir,
        "greet.js",
        [
          "function greetOld(name) {",
          "  return 'hi ' + name;",
          "}",
          "console.log(greetOld('world'));",
          "",
        ].join("\n"),
      );
    },
    prompt:
      "In greet.js, rename the function greetOld to greetNew everywhere it appears (definition and call). Keep the behavior identical.",
    async check(dir) {
      const content = await readFile(dir, "greet.js");
      if (/greetOld/.test(content)) return { pass: false, detail: "greetOld still present" };
      if (!/greetNew/.test(content)) return { pass: false, detail: "greetNew not found" };
      const { ok, out } = await runNode(dir, "greet.js");
      if (!ok) return { pass: false, detail: `greet.js failed to run: ${out.slice(0, 80)}` };
      return out === "hi world"
        ? { pass: true, detail: "renamed and behavior preserved" }
        : { pass: false, detail: `output changed: ${JSON.stringify(out)}` };
    },
  },
  {
    id: "retrieve-answer",
    title: "Find a value defined in the codebase",
    tags: ["retrieve", "read"],
    async setup(dir) {
      await write(dir, "src/util.ts", "export function noop() {}\n");
      await write(dir, "src/settings.ts", "export const MAX_RETRIES = 7;\nexport const TIMEOUT = 30;\n");
      await write(dir, "src/index.ts", "import { MAX_RETRIES } from './settings.js';\nconsole.log(MAX_RETRIES);\n");
    },
    prompt:
      "What is the numeric value of MAX_RETRIES defined in this codebase? Answer with just the number.",
    async check(_dir, finalText) {
      return /\b7\b/.test(finalText)
        ? { pass: true, detail: "answered 7" }
        : { pass: false, detail: `answer did not contain 7: ${finalText.slice(0, 80)}` };
    },
  },
  {
    id: "fix-bug",
    title: "Fix a syntax error so the script runs",
    tags: ["read", "edit", "shell"],
    async setup(dir) {
      await write(
        dir,
        "broken.js",
        ["function main() {", "  console.log('DONE'", "}", "main();", ""].join("\n"),
      );
    },
    prompt:
      "broken.js has a syntax error. Fix it so that running `node broken.js` prints DONE.",
    async check(dir) {
      const { ok, out } = await runNode(dir, "broken.js");
      if (!ok) return { pass: false, detail: `still failing: ${out.slice(0, 80)}` };
      return out.includes("DONE") ? { pass: true, detail: "prints DONE" } : { pass: false, detail: `output: ${JSON.stringify(out)}` };
    },
  },
];

export function findTasks(ids?: string[]): EvalTask[] {
  if (!ids || ids.length === 0) return EVAL_TASKS;
  const set = new Set(ids);
  return EVAL_TASKS.filter((t) => set.has(t.id));
}
