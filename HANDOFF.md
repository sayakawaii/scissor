# HANDOFF — scissor

A snapshot for the **next agent** taking over this repo. Read this first, then
`AGENTS.md` (working agreement / conventions) and the README "Architecture"
section. This file is a point-in-time state dump; `AGENTS.md` is the durable
contract. When in doubt, prefer `AGENTS.md`.

_Last updated: 2026-07-16 · at commit `35274bd` on `main`._

---

## 1. What scissor is (30-second version)

A personal, Cursor-like **terminal** AI coding agent. CLI-first (REPL + one-shot),
no GUI yet. Monorepo, npm workspaces, strict engine/UI split:

- `packages/core` — UI-agnostic engine: providers + heuristic router, the agent
  loop, tools, guardrail pipeline, prompt + retrieval, edit engine, MCP client,
  config + session store, intent heuristic. **No terminal deps.**
- `packages/cli` — terminal UI: commands, REPL/one-shot, rendering, approval
  prompts, session wiring, tracing + cost report, verification, the
  self-iteration supervisor, and the eval/benchmark harness.

Local-first, minimal deps: no server/DB/vector store. State lives under
`~/.scissor` (config, sessions, traces) and in the workspace.

---

## 2. How to work here (must-know workflow)

```bash
# Node may not be on PATH in fresh Windows shells:
export PATH="/c/Program Files/nodejs:$PATH"

npm run typecheck      # tsc on both packages
npm run build          # tsup -> packages/*/dist  (REQUIRED before running scripts
                       # that import "@scissor/core": tests resolve the BUILT dist,
                       # not src. Forgetting this => "does not provide an export".)
npm test               # all deterministic scripts/test-*.mts
npm run eval           # 6-task real-LLM smoke (needs network + a provider key)
npm run bench          # harder benchmark suite (scissor/goose/custom)
npm run check          # typecheck + build + test + eval --strict (the full gate)

# Run the CLI in dev:
npm run scissor -- "your prompt"      # or: node --import tsx packages/cli/src/index.ts
```

**Definition of done (per iteration), from AGENTS.md — both must hold:**
1. Full gate green (`npm run check`).
2. Ships a new eval/bench case **or** a deterministic `scripts/test-*.mts` that
   would fail without the change. Register every new test in the root `test`
   script in `package.json`.

**Git / push:**
- Remote `origin` = `git@github.com:sayakawaii/scissor.git`, branch `main`.
- A **pre-push hook** runs the full gate (`typecheck + build + test + eval
  --strict`, ~80s). It blocks the push on failure.
- ⚠️ **This sandbox has no network.** `eval` therefore fails with `Connection
  error` on every task, which blocks pushes even when all code is correct. When
  that's the only failure, push with `SCISSOR_SKIP_EVAL=1 git push` (skips **only**
  eval; typecheck/build/tests still run). Do NOT skip if real tests fail.
- CRLF→LF warnings on commit are expected/benign on Windows.
- Batch related changes into one commit+push; conventional-ish subjects
  (`feat:`/`fix:`/`docs:`).

---

## 3. Architecture cheat-sheet (where things live)

| Concern | File(s) |
|---|---|
| Agent loop, tool dispatch, subagents, auto-clarify wiring | `packages/core/src/agent.ts` |
| Providers (Anthropic + OpenAI-compatible), router | `packages/core/src/providers/` |
| Router tier resolution + `routerWouldHelp` | `packages/core/src/config.ts` |
| System prompt + `CLARIFY_GUIDANCE` | `packages/core/src/prompt.ts` |
| Vagueness heuristic (`isVagueRequest`) | `packages/core/src/intent.ts` |
| Guardrails (TDD, approval, oscillation) | `packages/core/src/guardrails.ts` |
| Tools | `packages/core/src/tools/*.ts` (+ `index.ts` registers `defaultTools`) |
| Retrieval / repo map (`retrieve`, `retrieveMulti`, `buildRepoMap`) | `packages/core/src/repo-index.ts` |
| Edit engine (fuzzy/multi-hunk apply) | `packages/core/src/edit-engine.ts` |
| Config + sessions | `packages/core/src/config.ts`, `session-store.ts` |
| MCP client | `packages/core/src/mcp/` |
| CLI entry / flags | `packages/cli/src/index.ts` |
| Session wiring (provider/router/trace/clarify/tdd) | `packages/cli/src/session.ts` |
| REPL + one-shot + slash commands | `packages/cli/src/commands/chat.ts` |
| Tracing + retention | `packages/cli/src/trace.ts` |
| Verification loop | `packages/cli/src/verify-project.ts` |
| Self-iteration supervisor | `packages/cli/src/self/` |
| Eval + benchmark harness, bench tasks | `packages/cli/src/eval/` |

**Key invariants (don't break these):**
- Engine talks to UI only via `AgentCallbacks`. Never import CLI code into `core`.
- Control tools (`ask_user`, `present_plan`, `restart_self`, `update_scratchpad`,
  `spawn_subagent`, `spawn_subagents`) are intercepted in the loop; everything
  else is a normal `Tool`. Mark read-only tools `mutating: false` so they
  parallelize and skip approval.
- Cross-cutting tool policy goes in the **guardrail pipeline**, not the loop.
- A turn parallelizes tool calls **only when every call is read-only**; any
  mutating/control call makes the whole turn sequential (keeps post-edit state
  correct for e.g. `diagnostics`).

---

## 4. What was just done (this handoff's session)

All shipped, committed, and pushed. Recent commits (newest first):

- `35274bd` **Router auto-enable + trace on by default** (see §5 "recently changed
  defaults").
- `d29b84b` **Auto intent-clarification** via the `isVagueRequest` heuristic.
- `5173c8b` **Multi-query retrieval** (query rewriting) + the initial
  intent-clarification gate.
- `22fe4e0` Parallel multi-agent fan-out (`spawn_subagents`).
- `f1dc28c` `ask_user` multi-select + non-blocking prompts for headless runs.

Details of the newest three (most likely to matter):

**Multi-query retrieval** — `retrieve` tool now accepts a `queries: string[]` in
addition to `query`. `retrieveMulti()` scores every file against each phrasing in
one pass and keeps the best per file, so the model can rewrite vague/misspelled
requests into several normalized phrasings to lift recall. `retrieve()` is a thin
single-query wrapper. Tests: `scripts/test-retrieve.mts`.

**Intent clarification (auto)** — three modes, default **auto**:
- auto: `Agent.autoClarify` runs `isVagueRequest(userInput)` each run; if vague, it
  appends `CLARIFY_GUIDANCE` to the system prompt **for that run only** (transient
  `clarifyActive` flag, cleared in a `finally`). Zero cost for specific requests.
- always: `--clarify` / `clarifyIntent` config / `SCISSOR_CLARIFY=1` bakes the
  guidance in statically.
- off: `SCISSOR_NO_CLARIFY=1`.
- The heuristic is **precision-biased**: fires only when a vague marker is present
  AND there's no concrete target (path/identifier/code fence/URL) AND the request
  is short. Tests: `scripts/test-intent.mts`, `scripts/test-clarify.mts`.

**Router + trace defaults** — see §5.

---

## 5. Recently changed defaults (so you're not surprised)

These used to be opt-in and are now automatic:

- **Model router: auto by default.** Enables itself when it would actually help —
  the strong tier has a key AND resolves to a distinct model (`routerWouldHelp`).
  True out of the box for DeepSeek (`deepseek-chat` → `deepseek-reasoner`). A lone
  GPT key => no distinct strong tier => stays off. Force on: `--router` /
  `config.router.enabled`. Force off: `SCISSOR_NO_ROUTER=1`.
- **Tracing: on by default.** Every session writes
  `~/.scissor/traces/<id>.jsonl`. Retention capped to the newest
  `SCISSOR_TRACE_KEEP` traces (default 50) via `pruneTraces()`. Disable:
  `SCISSOR_NO_TRACE=1`.
- **Intent clarification: auto by default** (see §4).

Full parameter inventory (flags, env, config) is in the README; the notable env
toggles are: `SCISSOR_NO_ROUTER`, `SCISSOR_NO_TRACE` / `SCISSOR_TRACE_KEEP`,
`SCISSOR_NO_CLARIFY` / `SCISSOR_CLARIFY`, `SCISSOR_NO_VERIFY` /
`SCISSOR_VERIFY_COMMANDS`, `SCISSOR_NO_MCP` / `SCISSOR_MCP_CONFIG`,
`SCISSOR_DIAGNOSTICS_COMMAND`, `SCISSOR_SKIP_EVAL`, `SCISSOR_CONFIG_DIR`.

---

## 6. Gotchas learned the hard way

- **Build before running `@scissor/core` scripts** (tests import the built dist).
- **No network in this environment** → `eval`/smoke fail with `Connection error`;
  use `SCISSOR_SKIP_EVAL=1 git push`. This is an environment limitation, not a bug.
- **Windows paths with spaces** (`C:\Program Files\nodejs\node.exe`): quote args
  / use `shell:true` when spawning; don't naively split templates on whitespace.
- **Anthropic role alternation**: don't inject two same-role messages in a row.
  Per-run system-prompt tweaks (like clarify) go through `renderSystemPrompt` /
  `syncSystemPrompt`, not by pushing extra transcript messages.
- **`diagnostics` tool takes no free-form command** (that would bypass the
  `run_shell` approval gate). Command is derived from project scripts /
  `SCISSOR_DIAGNOSTICS_COMMAND`; the model can only pick `checker: typecheck|lint`.
- **Dangerous shell commands** (`rm -rf`, `git push --force`, `mkfs`, …) always
  prompt for approval even under `--auto` (`shell.ts` DANGEROUS_PATTERNS +
  approval guard). Keep that behavior.

---

## 7. What's next / open threads

The immediate open thread from the last exchange:

- **B-level: context budget per model (not yet done).** `maxContextChars` is
  hard-coded (200k). Make it adapt to the actual context window of the active
  model (lookup by provider/model), so compaction/trim fires appropriately per
  model. Pure heuristic, low risk. This was explicitly flagged as the remaining
  A/B-level item after router+trace shipped.

Backlog highlights (see `OPEN_ITEMS.md` for the full, authoritative list):
- Make the clarify gate a **hard guardrail** (block first plan/edit until an
  `ask_user` fired when `isVagueRequest` matches), instead of prompt-only.
- **Fuzzy token matching** inside `retrieve` (edit-distance) so a single typo hits
  even without the model rewriting.
- Optional **embedding index** for semantic retrieval; incremental repo-map
  re-index after edits.
- Richer MAS (sub-agent coordination), and guarding heavyweight parallel
  duplication.
- Tune `isVagueRequest` against real traced sessions (now that tracing is on by
  default, there's data).

**Decision-making norm** (from AGENTS.md): decide freely on naming/formatting/
equivalent choices; ask the user only for scope changes, destructive actions, or
genuine product decisions.

---

## 8. First moves for the new agent

1. `export PATH="/c/Program Files/nodejs:$PATH"` then `npm run build && npm test`
   to confirm a green baseline.
2. Read `AGENTS.md` (contract) and the README "Architecture" section.
3. Skim `OPEN_ITEMS.md` for the authoritative backlog and what's already `[x]`.
4. Pick up §7's context-budget item, or whatever the user asks next.
5. Ship with a test, run `npm run check`, then
   `SCISSOR_SKIP_EVAL=1 git push` (network-limited env).
