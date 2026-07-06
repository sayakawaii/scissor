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

`edit_file` requires an exact unique `old_string`; models often get whitespace or
context slightly wrong and the edit fails.

- Fuzzy/robust matching (ignore trailing whitespace, tolerate minor drift).
- A dedicated "apply" step: given a rough edit, reconcile it against the real file.
- Multi-hunk edits in one call; line-range-based edits as an alternative.
- Auto-retry with feedback when an edit fails to match.

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

- Summarize dropped history into a rolling "what happened so far" note instead of
  discarding it (a `/compact` equivalent).
- Separate short-term (conversation) from long-term (`SCISSOR_MEMORY.md`) memory;
  auto-propose additions to long-term memory when durable facts are learned.
- Sub-agents for large tasks (spawn a focused child agent, return a summary).

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

- A small suite of repeatable tasks (create/edit/run) scored automatically, so
  prompt/tool changes can be measured instead of guessed.
- Track pass rate per provider to guide tuning.

## 8. UX polish

- Better streaming layout, spinners during tool runs, syntax-highlighted code.
- `/model` and `/provider` switching mid-session.
- Richer diff rendering (word-level highlights).
- Config/first-run onboarding when no key is present.

## 9. Self-iteration hardening (extends the shipped supervisor)

- Run the smoke suite (not just type-check + build) inside the verification gate.
- Loop/oscillation detection: stop if the agent keeps failing the same self-edit.
- Require explicit human approval for self-edits by default (plan-gate already
  helps; make it a hard gate for `restart_self`).
- Persist a self-update changelog across generations.
