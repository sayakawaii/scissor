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
  - [x] **Scheme D — real-code-grounded task**: `omci-uint40-decode-bug`, ported
    from the iop-toolkit backend's `service/omcianalyzer/omciSchema/util.go`. There
    most widths use `binary.BigEndian`, but the 40-bit path (`Uint40`) is
    hand-rolled with explicit shifts; here the 5-byte decoder scales the MSB by
    2**32→2**24, so it's only wrong once the value ≥ 2**32 (small inputs and all
    other widths pass). Buried in an omci-flavoured tree with correct look-alike
    decoders as red herrings; probe-scored (b[0] spans 0→full 2**40-1) with a
    hardcode guard, so it needs range reasoning + retrieval, not grep. Hermetic
    (Node), so it's in the gated `BENCH_TASKS`. (`bench-tasks.ts`; deterministic
    coverage in `scripts/test-bench.mts`.)
  - [x] **Scheme A — real-codebase retrieval QA (`iop-toolkit` backend).** A set
    of read-only QA tasks over a real ~190-file Go service (nested `service/`
    packages). Each asks a question whose answer is a precise token living in one
    non-obvious file (module name, Kafka client, a route's handler, a route-group
    prefix, config topic keys, the EVTOCD-deshape file), so answering rewards
    repo-map/retrieve while a near-naked harness must blind-read/grep. Zero
    toolchain (no build/test), scored by case-insensitive all-of token match.
    Source is a cached tree (env `SCISSOR_IOP_BACKEND`, default
    `~/.scissor/iop-cache/backend`); tasks are reachable only by id via
    `resolveTasks` so they never enter the hermetic default suite. Run:
    `scissor ab --candidate bare -t iop-module-name,iop-library-search-handler,…
    --runs 3`. (`packages/cli/src/eval/iop-tasks.ts`; deterministic
    `scripts/test-iop.mts`.)
    - [ ] **Live signal still pending — provider unreachable here.** Infra +
      deterministic test are green, but the bare-vs-scissor run needs an LLM.
      The corporate proxy 403-blocks `api.deepseek.com` (the only keyed provider)
      and Node bypasses the proxy (direct → ETIMEDOUT); anthropic/github are
      allowed. Re-run when a reachable+keyed provider is available (or add
      proxy-aware fetch + an anthropic key).
  - [x] **Scheme B — real `go test` bug-fix (`go-uint40-decode-bug`).** A
    self-contained, stdlib-only Go module with the same 40-bit decode bug ported
    from `omciSchema/util.go`, scored by an actual `go test` red→green (via an
    independent probe test, so editing the on-disk test can't cheat) plus a
    hardcode guard. Exercises the real cross-language path, not a JS stand-in.
    A WSL bridge runs `go` against the workspace `/mnt/<drive>` mount, offline
    (`GOPROXY=off`; `SCISSOR_GO_BIN` overrides the toolchain dir). Reachable only
    by id (needs Go), never in the hermetic gate. Validated end-to-end offline:
    buggy fails / correct `<<32` fix passes / hardcoded lookup rejected.
    (`packages/cli/src/eval/{go-helpers,go-tasks}.ts`; deterministic
    `scripts/test-go-tasks.mts` covers the pure bridge + setup without needing Go.)
  - [x] **Scheme C — verify-loop ablation on the Go task.** `go build ./...;
    go test ./...` wired via `SCISSOR_VERIFY_COMMANDS` makes scissor's verify loop
    meaningful on a non-Node project (it auto-detects Node only); `scissor ablate
    -t go-uint40-decode-bug` then quantifies the closed loop's pass/token/cost
    delta. Turns the "verify only auto-detects Node" gap into a measurable knob.
    (Recipe in `docs/benchmarking.md`; `goVerifyCommands()` helper + test.)
    - [ ] **Live signal (B/C) pending the LLM provider** (same block as A): the
      task/check are validated offline, but the bare-vs-scissor and verify-on/off
      *agent* runs need a reachable provider (DeepSeek is proxy-blocked here).
  - [x] **First distilled real historical bug (`omci-attr-slice-panic`).** Mined
    from the backend history and distilled from `omcianalyzer` commit `d5f27be`
    *"fix(omciSchema): clamp table attribute slice to payload length"*: pre-fix
    code sliced a schema attribute to its declared size without clamping to the
    received payload → slice-out-of-range panic on short payloads (proprietary MEs
    only in the default schema). Packaged self-contained (stdlib-only Go) so a
    real `go test` goes red→green; independent probe (fitting + overrunning
    schemas) + stub guard; same WSL/offline bridge as Scheme B. Validated offline:
    buggy panics / correct payload-length clamp passes / stubbed result rejected.
    (`go-tasks.ts`; deterministic coverage in `scripts/test-go-tasks.mts`.)
  - [ ] **Automate the distillation (`eval-gen --from-commit`).** Today `eval-gen`
    only drafts from a scissor trace; extend it to take a fix commit (message +
    changed files + pre-fix contents) and scaffold a red→green draft, so real bugs
    become tasks without hand-authoring. Mining tips: per-service repos carry full
    history — `omcianalyzer` (backend, 227 commits, richest), `webioptoolkit`
    (frontend), `collector`; prefer single-file logic fixes with a clear symptom
    in the message (`git log --grep=fix`). Good next candidates seen while mining:
    `e7c8f76` (PriorityQueue port parser), `20838cf` (Nokia ONU TX length < 120).
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

## 7e. Execution-scope estimation / over-reading (E3, arXiv:2607.13034)

Yin & Feng, *"Do AI Agents Know When a Task Is Simple? Toward Complexity-Aware
Reasoning and Execution"* (arXiv:2607.13034v1; code `github.com/eejyin/…`) —
**verified real.** Proposes **E3 (Estimate, Execute, Expand)**: estimate an
initial operating point `x₀=(difficulty, scope, risk, confidence)`, execute the
minimum viable path, expand scope only when verification fails. Formalizes
**ACRR** (Agent Cognitive Redundancy Ratio = (C_act − C_min)/C_min).

Honest read of the evidence: the headline (−85% cost / −91% tokens / −92% files
at 100% success) is on **MSE-Bench, a synthetic capability-controlled simulator**
(no LLM invoked; MCF is a deliberate worst-case baseline). The real-model harness
(**LLM-Case**, gpt-4o on real `toml`, 3 runs/task) shows the effect is *"milder
but real"*: a frontier model doesn't grossly over-read (1–4 files), E3 is the
leanest/fastest overall (~18% fewer tokens vs a "thorough" agent, ~4% vs ReAct,
roughly cost-neutral on trivial edits), and its main value is **not spending
itself into failure as hidden coupling grows**. So: directionally sound, modest
real gains → **measure before building.**

- [x] **Phase 0 — measure scissor's current over-reading.** The eval harness now
  records, per task, the distinct files pulled into context (`inspectedFiles`)
  and tool calls (`toolCalls`), for both the scissor and bare targets (via an
  `onToolEnd` trajectory accumulator). `EvalTask.oracle = { files, tokens? }`
  annotates the minimum-sufficient scope; the real tasks (`iop-*`, `go-*`,
  `buried-bug-fix`, `deep-median-bug`, `omci-uint40-decode-bug`) are annotated
  with `files: 1` (their answer/fix lives in one file). `compareRuns` sums these
  into per-arm `ArmReading`; `acrrFiles` computes the files-axis ACRR; `scissor
  ab` prints **files/task + over-read (ACRR files)** and `scissor ablate` adds a
  **files/task column + ACRR** to the matrix. This answers "does scissor over-read
  enough to be worth an estimator?" before any behavior change.
  (`eval/{runner,compare}.ts`, `commands/ablate.ts`; deterministic
  `scripts/test-acrr.mts`.) Live numbers pending a reachable provider (same block
  as §7d A/B/C).
- [ ] **Phase 1 — Estimate.** A transparent lexical-plus-one-probe scope
  estimator → `x₀`, as a pre-turn guardrail in `core`, flag `SCISSOR_ESTIMATE`
  (off by default). Deterministic test over localized vs broad-scope wording.
- [ ] **Phase 2 — Execute minimum viable path.** Drive the existing
  `SCISSOR_NO_REPOMAP`/`SCISSOR_NO_RETRIEVE` gates *from* `x₀`: low-difficulty
  localized edits skip repo-map/heavy retrieval; higher scope enables dependency
  tracing. Guardrail-based, reversible.
- [ ] **Phase 3 — Expand.** On verify failure / low confidence, bump a bounded
  scope level (reuse prior search hits, don't restart) and replan. The paper's
  ablation shows Expand is the safety net (removing it drops success to 85%), so
  it's required if Phases 1–2 ship.
- [ ] **Phase 4 (optional) — learned estimator.** Feed the experience layer's
  per-state option stats into the estimator so difficulty is learned from real
  traces (ties into the OaK advisor).

Bar for each phase: no pass-rate regression + a *measurable* tokens/files drop
(via `ab`/`ablate`), plus a new eval/bench case. Because real gains are modest,
Phase 0's measurement gates whether Phases 1+ are worth building.

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
