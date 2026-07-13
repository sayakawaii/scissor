# AGENTS.md — working agreement for scissor

Guidance for any AI agent (or human) working in this repo. Keep it short; update
it when conventions change.

## What this is

`scissor` is a personal, Cursor-like terminal AI coding agent. Monorepo with a
strict engine / UI split:

- `packages/core` — UI-agnostic engine: providers + router, the agent loop,
  tools, guardrails, prompt/retrieval, edit engine, MCP client, config + session
  store. **No terminal dependencies.**
- `packages/cli` — terminal UI: commands, REPL/one-shot, rendering, approval
  prompts, session wiring, tracing + cost report, verification, the
  self-iteration supervisor, and the eval/benchmark harness.

See the README "Architecture" section for diagrams.

## Success metrics (what "better" means)

Optimize, in priority order:

1. **Real-task autonomy** — can it finish a real, multi-step task with minimal
   human intervention.
2. **Reliability** — edits apply first try, no oscillation/retry loops, no bad
   self-edits slipping through the gate.
3. **Harder-benchmark pass rate** — grow `bench` toward genuinely differentiating
   tasks and track the rate; the 6-task `eval` is a smoke floor, not the goal.

## Definition of done (per iteration)

An iteration is done only when **both** hold:

1. The full gate is green: `npm run typecheck && npm run build && npm test &&
   npm run eval -- --strict`.
2. It ships **a new eval/bench case (or a deterministic test) that would fail
   without this change** — so the change is regression-protected and the eval
   signal grows. Use `scissor eval-gen` to bootstrap a case from a real session.

## Conventions

- **Engine stays UI-agnostic.** `core` talks to the UI only through
  `AgentCallbacks`. Never import CLI/terminal code into `core`.
- **Tools are data + `run()`.** Control tools (`ask_user`, `present_plan`,
  `restart_self`, `update_scratchpad`, `spawn_subagent`) are intercepted in the
  agent loop; everything else is a normal `Tool`. Mark read-only tools
  `mutating: false` so they parallelize and skip approval.
- **Cross-cutting tool policy goes in the guardrail pipeline**, not the core loop
  (TDD, approval, oscillation are all guardrails). Add new policy as a
  `Guardrail` with `beforeTool`/`afterTool`/`reset`.
- **Local-first, minimal deps.** No server, DB, or vector store. State lives
  under `~/.scissor` and in the workspace. Justify any new runtime dependency.
- **Tests are deterministic.** Prefer `scripts/test-*.mts` with a scripted mock
  `LLMProvider` and temp workspaces; reserve real-LLM runs for `eval`/smoke.
  Register every new test in the root `test` script.

## Commit / workflow

- **Batch related changes into one commit + push.** Each push runs the pre-push
  gate (typecheck + build + all tests + `eval --strict`, ~80s). Don't push once
  per tiny change. Locally, `SCISSOR_SKIP_EVAL=1 git push` bypasses only the eval
  step in emergencies; the gate still runs on the next real push.
- Conventional-ish commit subjects (`feat:`, `fix:`, `refactor:`, `docs:`) with a
  short body explaining the "why".
- Only commit when asked. Never commit secrets (`config.json`, `.env`, `mcp.json`
  are gitignored — keep it that way).

## Windows notes

- Node may not be on `PATH` in fresh shells; prepend `/c/Program Files/nodejs`.
- Git normalizes CRLF→LF on commit (warnings are expected/benign).
- Shell out through the platform shell (see `tools/shell.ts`); quote paths that
  may contain spaces.

## Autonomy

Decide freely on naming, formatting, and equivalent implementation choices — pick
a reasonable option and note it. Ask first only for scope changes, destructive
actions, or genuine product decisions (see the questions used to set the metrics
and done-bar above).
