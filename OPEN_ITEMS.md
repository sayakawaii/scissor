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
- [x] Query rewriting: `retrieve` accepts a `queries` array of normalized
  phrasings (corrected spelling / identifier names / synonyms). All files are
  scored against each phrasing in one pass; best match per file is kept. Lifts
  recall for vague/misspelled requests. (`retrieveMulti` in `repo-index.ts` +
  `tools/retrieve.ts`; covered by `scripts/test-retrieve.mts`)
- [ ] Optional embedding index for semantic retrieval; rank chunks by relevance
  and inject the top-K into context automatically.
- [ ] Fuzzy token matching (edit-distance) inside `retrieve` so a single typo'd
  query still hits even without the model rewriting it.
- [ ] Incremental re-index on file changes (the repo map is currently built once
  per session and can go stale after edits).

### Intent recognition / clarification

- [x] Intent-clarification gate: for clearly ambiguous requests the agent leads
  with a single `ask_user` offering 2–3 concrete interpretations before
  planning/editing, treating likely typos charitably. Three modes, default
  **auto**: a deterministic vagueness heuristic (`isVagueRequest`, precision-
  biased) fires per request and the agent injects the guidance for that turn
  only; `--clarify`/`clarifyIntent`/`SCISSOR_CLARIFY=1` force it always;
  `SCISSOR_NO_CLARIFY=1` disables. No LLM classifier, no per-turn cost when
  quiet. (`packages/core/src/intent.ts` + `CLARIFY_GUIDANCE`/`autoClarify`;
  covered by `scripts/test-intent.mts` + `scripts/test-clarify.mts`)
- [ ] Make the gate a hard guardrail (block the first plan/edit until an
  `ask_user` fired) when the vagueness heuristic fires, instead of relying on
  prompt adherence. Reuse `isVagueRequest`.
- [ ] Broaden the heuristic (more vague markers / multilingual) and/or tune it
  against real traced sessions to catch misses without adding false positives.

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
- [x] `diagnostics` tool — an on-demand type-checker/linter feedback channel: the
  agent can run the project's `typecheck`/`lint` script (or `tsc --noEmit`,
  auto-detected; `checker` arg selects one) and gets back structured
  `file:line:col severity message` diagnostics, optionally filtered to one file.
  A pragmatic slice of "LSP as a feedback channel". The command is never taken
  from model input (only project scripts / tsconfig / the user-set
  `SCISSOR_DIAGNOSTICS_COMMAND`), so it can't bypass `run_shell`'s approval gate.
  Behaviorally covered by the `type-error-fix` bench task.
  (`packages/core/src/tools/diagnostics.ts`)
- [ ] Broaden toolchain detection beyond Node (pytest, cargo, go test, etc.).
- [ ] Run tests (not just typecheck/lint) when they are fast/safe.
- [ ] Surface a concise diff + test summary at the end of a task.
- [ ] Full LSP integration (persistent language server: go-to-def, references,
  rename, hover) — the `diagnostics` tool covers the highest-value 80% for now.

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
- [x] Sub-agents for large tasks: the `spawn_subagent` tool delegates a
  self-contained sub-task to a fresh child agent (own clean context, same
  workspace + worker tools) and returns only its summary; depth-guarded so
  children can't spawn children. (`runSubagent` in `packages/core/src/agent.ts`,
  `spawn_subagent` in `tools/control.ts`.)
- [x] Parallel multi-agent fan-out (MAS): `spawn_subagents` runs several
  INDEPENDENT sub-tasks as concurrent child agents and fans in their summaries
  (map-reduce), capped at 5 and depth-guarded. Tasks must touch disjoint files
  (shared workspace). (`runSubagentsParallel`/`runOneSubagent` in
  `packages/core/src/agent.ts`; `scripts/test-subagent.mts` cases 4–6.)
- [ ] Richer MAS: role-based orchestration (planner / worker / critic) and a
  shared scratchpad/blackboard beyond the filesystem; a Reflexion-style critic
  agent would also upgrade the reflection loop (§9).
- [x] Parallel read-only tool execution: a turn's calls run concurrently **only
  when they are all read-only**; any mutating/control call makes the whole turn
  sequential in call order, so a read-only call (e.g. `diagnostics`, `read_file`)
  requested after an edit in the same turn observes the post-edit state. Results
  are fed back in original order. (`isParallelSafe` + the tool loop in
  `packages/core/src/agent.ts`; regression in `scripts/test-parallel.mts`.)
- [ ] Guard against heavyweight parallel duplication: several read-only calls in
  one turn could each spawn a long (≤120s) `diagnostics`/type-check. Consider a
  per-tool concurrency cap or a short-lived result cache so N parallel checks
  don't each rebuild the project.

### 4a. Short-term (working) memory handling — backlog

The "short-term" memory is the live conversation window the model sees each turn.
Today it is: full transcript → auto-compaction past a threshold → hard-trim of
oldest rounds. Improvements to pursue:

- [x] Structured scratchpad: a small, always-injected "working set" (current
  goal, files in play, last error, next step, notes) maintained separately from
  the raw transcript, so key state survives compaction verbatim instead of being
  paraphrased into the summary. Maintained via the `update_scratchpad` tool,
  pinned into the system prompt, persisted per session (survives `--resume` and
  self-update restarts), viewable with `/scratchpad`. (`Scratchpad` in
  `packages/core/src/types.ts`, `update_scratchpad` in `tools/control.ts`,
  render/merge in `Agent`.)
- [ ] Token-based budgeting instead of character counts (per-provider tokenizer),
  and a per-turn context budget so retrieval/tool output can't blow the window.
- [ ] Relevance-aware trimming: keep the messages most relevant to the current
  request (e.g. the files it touches) rather than strictly the most recent.
- [ ] Tool-output summarization: fold large tool results (long file reads, shell
  output) into compact references once they're no longer the focus.
- [ ] Tune when auto-compaction fires and how much recent context it preserves;
  measure the effect on eval pass rate.

### 4b. Long-term (persistent) memory handling — backlog

Long-term memory is `SCISSOR_MEMORY.md` (durable facts) + saved sessions. Gaps:

- [ ] Structured memory store instead of a flat markdown file: scoped entries
  (project vs. global), timestamps, and dedup so the file doesn't grow unbounded.
- [ ] Retrieval of long-term memory (only inject the entries relevant to the
  current task, like codebase retrieval, rather than the whole file every time).
- [ ] Semantic recall across past sessions (embed prior session summaries; surface
  the relevant ones for a new, related task).
- [ ] Memory hygiene: expire/curate stale facts; let the user review and edit
  what was auto-remembered.
- [ ] Decide precedence when memory conflicts with the current repo state (repo
  wins) and make that explicit in the prompt.

## 5. Checkpoints & undo (beyond git)

- Per-action snapshots so a single tool call can be undone without a full git reset.
- `/undo` and `/redo` in the REPL.
- Show a session-level change summary (files touched, +/- lines).

## 6. Provider/model robustness

- [x] Heuristic model router: score each turn and route to a cheap or strong
  model tier. **Auto by default** — enabled when it would help (strong tier has a
  key and a distinct model; `routerWouldHelp` in `config.ts`); `--router`/
  `router.enabled` force it on, `SCISSOR_NO_ROUTER=1` off. Escalates on
  complex-intent keywords, large context, long-running turns, and failed
  verification; degrades gracefully when the strong tier has no key. Validate
  with `scissor eval --router`. (`packages/core/src/providers/router.ts`,
  `resolveRouterTiers`/`routerWouldHelp` in `config.ts`, `createRoutedProvider`.)
- [x] Structured JSONL tracing: per-session events (turn, route, tool timing,
  usage, verify, compact, subagent) written to `~/.scissor/traces/<id>.jsonl`.
  **On by default** (costs only disk, feeds the trace→eval flywheel), self-
  limiting to the newest `SCISSOR_TRACE_KEEP` traces (default 50, `pruneTraces`);
  `SCISSOR_NO_TRACE=1` disables. (`packages/cli/src/trace.ts`)
- Retries with backoff on 429/5xx and transient network errors.
- Streaming reasoning display for reasoning models (e.g. deepseek-reasoner).
- [x] Token accounting + cost estimate per turn/session: `scissor trace`
  aggregates a session's trace into per-model token totals + estimated USD cost
  (approximate built-in price table), routing split, and tool stats.
  (`packages/cli/src/trace-report.ts`, `commands/trace.ts`)
- Learned/data-driven routing: replace the heuristic score with a tiny trained
  classifier over past turns (à la OpenSquilla's SquillaRouter), keeping the
  heuristic as the cold-start fallback.
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
- [x] Harder bench task distilled from a real run: `json-csv-roundtrip` probes
  RFC-4180 quoting + a lossless JSON↔CSV round trip (not just "a file exists").
- [x] `type-error-fix` bench task: a defect surfaced by the project's checker;
  the agent must use the checker feedback (via `diagnostics`) and repair it so
  the check passes — a behavior-level test for the diagnostics feedback loop.
- [x] trace→eval flywheel (minimal): `scissor eval-gen [trace]` turns a real,
  traced session into a *draft* regression eval case — it recovers the user
  prompt and the files the agent produced and scaffolds a check. Traces now
  record a `user` (prompt) event and write/edit `path`s to make this possible.
  (`packages/cli/src/eval-gen.ts`, `commands/eval-gen.ts`)
- [ ] Close the flywheel's second half: promotion is manual today and drafts land
  in the git-ignored `evals/` dir. Add `scissor eval --include <file>` (or auto-
  discovery of `evals/generated/*`) so a draft can be run without hand-editing,
  and make accepted cases easy to commit into the suite.
- [ ] Broaden capture beyond "produced files": eval-gen ignores final answer text
  and shell side-effects, so Q&A/retrieval sessions (e.g. `retrieve-answer`)
  generate an empty-assertion draft. Record the final text + key shell outputs in
  the trace and synthesize answer-contains / stdout-contains checks.
- [ ] Auto-tighten generated drafts (assert contents / run the program) and offer
  to append accepted drafts straight into the suite.
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

## 7d. Harness value / cost-quality benchmarking (Databricks-style)

Prove scissor's scaffolding earns its keep vs a bare model call. Databricks'
2026 internal benchmark (Zaharia et al.) showed the *harness* changes cost-per-
task by >2x at equal quality, and that per-token price is a poor proxy for per-
task cost — so we measure **success rate AND cost/tokens per task**, holding the
model fixed. Methodology: fixed model + fixed task set, run multiple arms, report
pass rate + tokens/task + est. cost/task; repeat N times for stochasticity.

- [x] **(A) Bare baseline target**: an in-process minimal harness AgentTarget —
  read/write/edit/shell only, ~1-line system prompt, no repo-map, retrieval,
  verify, guardrails, router, memory, or scratchpad (a Pi-style baseline). Runs
  in the same `runSuite` with identical checks. (`packages/cli/src/eval/bare.ts`)
- [x] **(B) Per-task cost instrumentation**: `TaskResult` carries prompt/
  completion tokens + est. `costUsd` (via the `MODEL_PRICES` table); `compareRuns`
  aggregates tokens/task and cost/task, and `formatComparison` prints the
  Databricks-style cost-quality delta. Surfaced via `scissor ab --candidate bare`
  (baseline=bare, candidate=scissor, router+experience off → model fixed).
  (`packages/cli/src/eval/{runner,compare}.ts`, `commands/ab.ts`)
- [x] **(C) Ablation matrix over scissor's own scaffolding**: `scissor ablate`
  runs the suite full (reference) and once per component with it disabled
  (repo-map / retrieve / verify-loop today; router held off so the model is
  fixed), producing a pass/token/cost matrix — "which scaffolding earns its token
  cost", the Databricks lesson applied inward. New env toggles `SCISSOR_NO_REPOMAP`
  / `SCISSOR_NO_RETRIEVE` gate the previously always-on components.
  (`packages/cli/src/commands/ablate.ts`, `buildAblation`/`formatAblation` in
  `eval/compare.ts`; deterministic `scripts/test-ablate.mts`.) Extend with more
  knobs (router, experience-advice, clarify) as they prove interesting.
- [~] **(D) Real-codebase task set (Databricks-faithful)**: curate a harder
  benchmark of real, reviewed tasks on a real repo (scissor itself and/or a chosen
  OSS repo) via `eval-gen` from actual sessions, instead of the small synthetic
  eval/bench tasks — addresses "SWE-bench doesn't reflect your codebase". Highest
  fidelity/signal; largest effort (task curation + trustworthy checks).
  - [x] First differentiating case: `buried-bug-fix` bench task — a defect in one
    function buried in a larger multi-directory tree with same-topic red herrings,
    so *locating* it (repo-map/retrieve) matters and a near-naked harness must
    blind-grep. Behavior checked over several varied cases (hardcode-resistant).
    (`bench-tasks.ts`; deterministic coverage in `scripts/test-bench.mts`.)
  - [~] Grow into a dedicated harder tier (more buried/multi-file tasks; larger
    trees) and distill real ones from traced sessions via `eval-gen`. Added
    `deep-median-bug`: a ~50-file tree with a *subtle* even-length median bug
    (odd-length inputs pass, so it needs edge-case reasoning, not just grep),
    probe-scored so editing `check.js` can't pass it.
  - [ ] Curate reviewed tasks on scissor's own repo / a chosen OSS repo with
    trustworthy checks (the high-fidelity, high-effort end).
- [x] Run each arm N times and report mean ± spread (LLM runs are stochastic;
  a single run misleads). `scissor ab --runs N` repeats both arms and reports
  per-arm mean/min/max/σ of tasks passed, mean tokens/cost per task, the mean
  pass delta, and a per-task pass-rate table for the tasks that differ.
  (`packages/cli/src/eval/repeat.ts`; deterministic `scripts/test-repeat.mts`.)
  Still TODO: an `--runs` equivalent for `scissor ablate`.
- [ ] Add an external-harness arm (e.g. Pi/aider) via the existing
  `--agent custom --agent-cmd` adapter for a third reference point (their token
  cost isn't in-process, so cost there is out of scope unless the CLI reports it).

## 7c. Test-first (TDD) mode

- [x] Opt-in hard gate (`--tdd` / config `tddMode`): the agent must create/edit a
  test file before writing source code; source-first edits are rejected with
  guidance. Non-code files are not gated. (`isTestFile`/`isSourceFile` in
  `packages/core/src/tdd.ts`, enforced in `Agent.handleToolCall`.)
- [x] The verification loop also runs the project `test` script in TDD mode.
- [ ] Optionally require the new test to actually fail first (true red-green),
  not just exist.

## 8. UX polish

- [x] Installable global command: root `bin` + `npm link` (documented in the
  README) so `scissor` runs from any directory.
- [x] `--auto` no longer stalls on plan approval: plans are auto-approved (shown
  for visibility) while dangerous actions still confirm, so one-shot/piped runs
  don't hang. (`autoApprovePlan` in `packages/cli/src/ui/prompts.ts`)
- [x] `ask_user` click-to-choose Q&A: with `options` the user picks via a
  keyboard select instead of typing; `allow_multiple` uses a checkbox
  (space to toggle, enter to submit) with an "Other" free-text escape. Under
  `--auto` or when there's no TTY, questions are auto-answered (non-blocking) so
  headless/piped runs don't hang. Full GUI popup (mouse click) still needs the
  planned Electron layer. (`promptAskUser`/`autoAnswerAsk`,
  `isNonInteractive` in `commands/chat.ts`)
- Better streaming layout, spinners during tool runs, syntax-highlighted code.
- `/model` and `/provider` switching mid-session.
- Richer diff rendering (word-level highlights).
- Config/first-run onboarding when no key is present.

## 9. Self-iteration hardening (extends the shipped supervisor)

- [x] Run the eval suite (not just type-check + build) inside the verification
  gate, so self-edits that break behavior are rolled back. Skippable via
  `SCISSOR_SKIP_EVAL=1`, subset via `SCISSOR_SELFUPDATE_EVAL_TASKS`.
  (`verifySelfUpdate` in `packages/cli/src/self/verify.ts`)
- [x] Loop/oscillation detection: the guardrail pipeline ships a built-in
  oscillation guard that blocks the exact same tool call once it has failed
  `limit` times (default 3), forcing a change of approach. Enabled by default in
  the CLI session. (`createOscillationGuard` in `packages/core/src/guardrails.ts`;
  pipeline in `handleToolCall`.)
- [x] Unified lifecycle hooks: TDD gating and the approval prompt were refactored
  out of the core loop into the same guardrail pipeline (`createTddGuard`,
  `createApprovalGuard`), so all before/after-tool policy composes in one place
  (`[TDD?] → user guards → approval`), each with an optional `reset()`.
- Require explicit human approval for self-edits by default (plan-gate already
  helps; make it a hard gate for `restart_self`).
- Persist a self-update changelog across generations.
