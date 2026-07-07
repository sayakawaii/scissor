# Open Items — scissor backlog

Engineering work that would move scissor from "works" to "genuinely good", roughly
in priority order. These are the things that separate commodity agent loops (like
the current core) from products like Cursor / Claude Code. Not yet implemented.

## 1. Codebase retrieval / context management (highest impact)

Right now the model only sees files it explicitly `grep`/`read`s. A real agent
needs to proactively surface the right context.

- [x] Build a workspace index: file tree + symbol map ("repo map"), injected
  into the system prompt. (`packages/core/src/repo-index.ts` `buildRepoMap`)
- [x] Cheap first version: heuristic retrieval (filename/path/keyword scoring)
  exposed as the `retrieve` tool. (`retrieve` in `repo-index.ts` + `tools/retrieve.ts`)
- [x] Respect `.gitignore`.
- [ ] Optional embedding index for semantic retrieval; rank chunks by relevance
  and inject the top-K into context automatically.
- [ ] Incremental re-index on file changes (the repo map is currently built once
  per session and can go stale after edits).

## 2. Edit reliability ("apply")

`edit_file` used to require an exact unique `old_string`; models often got
whitespace or line endings slightly wrong and the edit failed.

- [x] Fuzzy/robust matching: tolerates line-ending (CRLF/LF) and trailing-
  whitespace differences, plus stray leading/trailing blank lines, while only
  applying a fuzzy match when it is unique. (`packages/core/src/edit-engine.ts`)
- [x] Multi-hunk edits in one call via an `edits` array, applied atomically.
- [x] `replace_all` to replace every occurrence.
- [x] Near-miss hint on failure ("a line matching X exists at line N …") so the
  model's next attempt is cheaper. The tool error is fed back automatically.
- [ ] A dedicated LLM "apply" step: given a rough edit, reconcile it against the
  real file (for larger/structural edits).
- [ ] Line-range-based edits as an alternative addressing scheme.

## 3. Verification closed-loop

Make correctness a first-class part of the loop, not something the model may or
may not do.

- [x] After edits, automatically run project checks and feed failures back to the
  model to self-correct (bounded by `maxVerifyAttempts`). (`Agent.run` verify loop
  in `packages/core/src/agent.ts`)
- [x] Detect the project's toolchain (package.json `typecheck`/`lint` scripts),
  with `SCISSOR_VERIFY_COMMANDS` override and `--no-verify` / `SCISSOR_NO_VERIFY`
  to disable. (`packages/cli/src/verify-project.ts`)
- [ ] Broaden toolchain detection beyond Node (pytest, cargo, go test, etc.).
- [ ] Run tests (not just typecheck/lint) when they are fast/safe.
- [ ] Surface a concise diff + test summary at the end of a task.

## 4. Context compaction / long-horizon memory

Current trimming just drops old rounds. Better:

- [x] Summarize old history into a rolling "what happened so far" note instead of
  discarding it, automatically past a threshold and via `/compact`. The rolling
  summary is protected from the hard-trim fallback. (`Agent` compaction in
  `packages/core/src/agent.ts`)
- [x] Long-term memory: the `remember` tool (and `/remember`) append durable
  facts to `SCISSOR_MEMORY.md`, which is loaded into future sessions.
  (`packages/core/src/tools/remember.ts`)
- [ ] Auto-propose long-term memory additions (currently the agent must choose to
  call `remember`); detect durable facts and suggest saving them.
- [ ] Sub-agents for large tasks (spawn a focused child agent, return a summary).

## 5. Checkpoints & undo (beyond git)

- Per-action snapshots so a single tool call can be undone without a full git reset.
- `/undo` and `/redo` in the REPL.
- Show a session-level change summary (files touched, +/- lines).

## 6. Provider/model robustness

- Retries with backoff on 429/5xx and transient network errors.
- Streaming reasoning display for reasoning models (e.g. deepseek-reasoner).
- Token accounting + cost estimate per turn/session.
- Per-provider tool-calling quirks handled (some models format tool args loosely).
- Real end-to-end validation for Claude / GPT / GLM (only DeepSeek is key-tested).

## 7. Eval harness

- [x] A small suite of repeatable tasks (create/edit/run/refactor/retrieve/fix)
  scored automatically in isolated temp workspaces, so prompt/tool changes can be
  measured instead of guessed. Run with `scissor eval` / `npm run eval`.
  (`packages/cli/src/eval/**`, tasks in `eval/tasks.ts`)
- [x] Per-provider runs (`--provider all`) and JSON output (`--json`) to track
  pass rate over time.
- [x] A harder, differentiating **benchmark** suite (`scissor bench` /
  `npm run bench`): scaffold-a-CLI, debug-a-failing-test, multi-file rename,
  CSV data transform, dependency-version lookup in a larger tree.
  (`packages/cli/src/eval/bench-tasks.ts`)
- [x] Agent-agnostic harness: `runSuite` + `AgentTarget` so the same tasks/checks
  score scissor or any headless CLI agent; built-in **goose** adapter
  (`--agent goose`) and a `--agent custom --agent-cmd "... {PROMPT}"` template.
  (`packages/cli/src/eval/{runner,agents}.ts`)
- [ ] More tasks (larger multi-file refactors, ambiguous requests) and difficulty
  tiers.
- [ ] CI integration / historical trend tracking of pass rate.

## 7b. Capability gaps vs. goose (comparison backlog)

goose is a mature, general-purpose agent; the biggest deltas to close:

- [x] MCP support (goose's core extensibility model): scissor has a built-in MCP
  client (`packages/core/src/mcp/**`) + `scissor mcp` management, so any stdio or
  Streamable-HTTP MCP server can extend the agent. External tools go through the
  approval gate; images are saved to `.scissor/mcp-images/`.
- [x] Browser automation / screenshots via the Playwright MCP preset
  (`scissor mcp add browser`) — the open-ecosystem equivalent of Cursor's
  built-in browser.
- [x] Windows desktop control + screenshots via the Terminator MCP preset
  (`scissor mcp add desktop`).
- [ ] Non-coding tool breadth beyond the above (PDF/DOCX reading, etc.) — now a
  matter of adding MCP servers rather than core code.
- [ ] Recipes / parameterized reusable workflows (`--recipe`, sub-recipes).
- [ ] Desktop app + REST server surface (scissor is CLI-only by design).
- [ ] Breadth of provider integrations (goose 15–30+; scissor has 4).
- [ ] Run the head-to-head once goose is installed (adapter is ready:
  `scissor bench --agent goose`).

## 7c. Test-first (TDD) mode

- [x] Opt-in hard gate (`--tdd` / config `tddMode`): the agent must create/edit a
  test file before writing source code; source-first edits are rejected with
  guidance. Non-code files are not gated. (`isTestFile`/`isSourceFile` in
  `packages/core/src/tdd.ts`, enforced in `Agent.handleToolCall`.)
- [x] The verification loop also runs the project `test` script in TDD mode.
- [ ] Optionally require the new test to actually fail first (true red-green),
  not just exist.

## 8. UX polish

- Better streaming layout, spinners during tool runs, syntax-highlighted code.
- `/model` and `/provider` switching mid-session.
- Richer diff rendering (word-level highlights).
- Config/first-run onboarding when no key is present.

## 9. Self-iteration hardening (extends the shipped supervisor)

- [x] Run the eval suite (not just type-check + build) inside the verification
  gate, so self-edits that break behavior are rolled back. Skippable via
  `SCISSOR_SKIP_EVAL=1`, subset via `SCISSOR_SELFUPDATE_EVAL_TASKS`.
  (`verifySelfUpdate` in `packages/cli/src/self/verify.ts`)
- Loop/oscillation detection: stop if the agent keeps failing the same self-edit.
- Require explicit human approval for self-edits by default (plan-gate already
  helps; make it a hard gate for `restart_self`).
- Persist a self-update changelog across generations.
