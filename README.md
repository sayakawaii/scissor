# scissor

A personal, Cursor-like terminal AI coding agent for Windows (and cross-platform). Chat with an LLM that can read, search, edit files and run commands in your current directory. No login, no MCP, no plugin marketplace — just a fast local agent.

Supports four providers out of the box: **DeepSeek**, **Claude (Anthropic)**, **OpenAI GPT**, and **GLM (Zhipu)**.

## Architecture

The project is a small monorepo with a strict engine / UI split so the core can later be reused by a GUI (e.g. Electron):

- `packages/core` — UI-agnostic engine: provider abstraction, agent loop, tools, config.
- `packages/cli` — terminal UI: REPL, one-shot mode, rendering, approval prompts.

## Requirements

- Node.js >= 18 (LTS recommended)

## Install

```bash
npm install
npm run build
```

To run without building, use `npm run dev -- <args>` (executes via `tsx`).

## Configure

Run the interactive wizard to store API keys in `~/.scissor/config.json`:

```bash
node packages/cli/dist/index.js config
# or during dev:
npm run dev -- config
```

Environment variables override stored keys: `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GLM_API_KEY`, and `SCISSOR_PROVIDER`.

## Usage

Interactive REPL:

```bash
scissor
```

One-shot:

```bash
scissor "explain what this repo does"
```

Options:

- `-p, --provider <id>` — choose `deepseek | claude | gpt | glm`
- `--safe` — confirm every file change and command
- `--auto` — run everything automatically (only confirm dangerous actions)
- `--chat-only` — disable file edits and command execution
- `--no-verify` — disable the automated verification closed-loop
- `--router` — route each turn to a cheap/strong model tier by difficulty
- `--tdd` — enforce test-first coding (block source edits until a test exists)

REPL slash commands: `/help`, `/reset`, `/compact`, `/scratchpad`, `/remember <fact>`, `/info`, `/exit`.

## Codebase retrieval

At session start scissor builds a compact **repo map** (directory tree + top-level
symbols, respecting `.gitignore`) and injects it into the system prompt, so the
agent begins with an overview instead of blindly grepping. It also has a
`retrieve` tool: ranked keyword search across the workspace that returns the most
relevant files and matching lines for a natural-language query — better than a
single `grep` for "where is X handled" questions.

## Verification closed-loop

When the agent finishes a request in which it edited files, scissor automatically
runs the project's checks and, if they fail, feeds the output back so the agent
can self-correct (bounded by `maxVerifyAttempts`, default 2). Checks are detected
from `package.json` scripts (`typecheck`/`type-check`/`tsc`, then `lint`).

- Override the commands with `SCISSOR_VERIFY_COMMANDS="cmd1;cmd2"`.
- Disable per-run with `--no-verify`, or globally with `SCISSOR_NO_VERIFY=1`.

## Model router (token efficiency)

Enable with `--router` (or `router.enabled` in config). Each turn is scored for
difficulty and sent to a **cheap** tier by default, escalating to a **strong**
tier only when the turn looks hard — so you spend premium tokens only where they
matter. The routing is transparent (explainable signals, not a black-box model);
strong-tier turns log a one-line reason to stderr.

Signals (weights): a complex-intent keyword such as *refactor/debug/architecture/
优化/并发* (+3), a failed verification on the previous turn (+3), large context
(+2) or medium context (+1), and a long-running turn (+1). A turn escalates at a
total score of 3 (configurable).

Defaults with a single DeepSeek key: cheap `deepseek-chat`, strong
`deepseek-reasoner` — no extra API key required. Configure tiers in
`~/.scissor/config.json`:

```json
{
  "router": {
    "enabled": true,
    "cheap":  { "provider": "deepseek", "model": "deepseek-chat" },
    "strong": { "provider": "claude" },
    "threshold": 3,
    "escalateOnVerifyFail": true
  }
}
```

If the strong tier has no API key, the router degrades gracefully to the cheap
tier. Force-disable for one run with `SCISSOR_NO_ROUTER=1`. Validate that routing
doesn't hurt task success with `scissor eval --router`.

## Reliable edits

`edit_file` uses a tolerant matching engine so small mismatches don't waste a
turn:

- Line-ending (CRLF/LF) and trailing-whitespace differences are tolerated, as
  are stray leading/trailing blank lines — but a fuzzy match is only applied when
  it is unique, and unchanged lines keep their exact original formatting.
- `replace_all` replaces every occurrence; otherwise a match must be unique.
- Pass an `edits` array to make several changes to one file atomically.
- On a miss, the error points at the closest matching line so the retry is cheap.

## Memory model

scissor has both short-term and long-term memory, deliberately built from
**local, zero-dependency primitives** — no Redis, no vector database. Those are
scaling tools (Redis for sharing session state across many server processes; RAG
for retrieving from a corpus too large to fit in context), and a single-user
local agent has neither problem. The right-sized equivalents below do the same
job without the operational weight.

### Short-term (working) memory

The live conversation the model sees each turn, managed in three layers:

- **Transcript** — the full message history for the current session.
- **Structured scratchpad** — a small, agent-maintained snapshot of task state
  (goal, next step, last error, files in play, notes), updated via the
  `update_scratchpad` tool and **pinned into the system prompt**. Because it
  lives in the system message, it survives context compaction and restarts
  *verbatim* even when older messages are dropped — so the agent doesn't lose
  the thread on long tasks. View it with `/scratchpad`.
- **Compaction & trim** — when the conversation grows past a threshold, the
  oldest rounds are summarized into a rolling "summary of earlier conversation"
  note (via the LLM) instead of being discarded; a hard trim of oldest whole
  rounds is the fallback. The rolling summary and the scratchpad are both
  protected from trimming. Trigger compaction manually with `/compact`.

Short-term memory is persisted per session (transcript + scratchpad) to
`~/.scissor/sessions/<id>.json`, so `--resume` (and self-update restarts) carry
it over. List sessions with `scissor sessions`.

### Long-term (persistent) memory

- **`SCISSOR_MEMORY.md`** — durable facts (conventions, key commands, gotchas)
  the agent saves via the `remember` tool (or you, via `/remember <fact>`). If
  present in the workspace, it is injected into the system prompt at the start of
  every future session.
- **Session archive** — every past session (goal + transcript + scratchpad) is
  stored under `~/.scissor/sessions/` and can be resumed.
- **Codebase retrieval** — the repo map + `retrieve` tool act as memory *of the
  codebase* (see [Codebase retrieval](#codebase-retrieval)).

When these outgrow simple whole-file injection (a large memory file, or semantic
recall across many sessions), an **optional** embedding index is the planned next
step — see the memory backlog in `OPEN_ITEMS.md`. It stays optional precisely so
the lightweight default keeps working with no extra infrastructure.

## Self-iteration (experimental)

scissor can modify and reload its **own** source code under a supervisor that
keeps it safe:

```bash
scissor supervise "make your grep tool case-insensitive by default"
```

How it works:

- A stable **supervisor** process spawns the agent as a child.
- The agent edits scissor's source, then calls the `restart_self` tool.
- The supervisor **checkpoints** the change (git commit), **verifies** the new
  version (type-check + build + the **eval suite**, so a self-edit that breaks the
  agent's actual behavior is caught), and either reloads into it or **rolls back**
  to the last working version automatically. Set `SCISSOR_SKIP_EVAL=1` to gate on
  build only, or `SCISSOR_SELFUPDATE_EVAL_TASKS=id1,id2` to run a subset.
- The session (memory) is persisted across restarts, so the conversation
  continues seamlessly into the new version.
- The safety machinery (`packages/cli/src/self/**`, `scripts/**`) is protected and
  cannot be modified by the agent.

See [OPEN_ITEMS.md](OPEN_ITEMS.md) for the roadmap of larger improvements.

## Eval harness

A small suite of repeatable tasks (create a file, edit JSON, write & run a
script, rename a function, find a value in the code, fix a syntax error) runs the
agent in isolated temp workspaces and scores each result automatically — so you
can measure whether a prompt/tool change actually helps instead of guessing.

```bash
scissor eval                       # run all tasks on the default provider
scissor eval --list                # list tasks
scissor eval -t edit-json,fix-bug  # run specific tasks
scissor eval -p all --json evals/run.json   # every configured provider, save results
# or during dev:
npm run eval
```

Each task reports pass/fail with turns and timing, plus a per-provider pass rate.

## Benchmark & agent comparison

`scissor bench` runs a harder, more differentiating suite (scaffold a CLI, debug
a failing test, multi-file rename refactor, CSV data transform, dependency
version lookup in a larger tree) and — importantly — is **agent-agnostic**: the
exact same tasks and objective checks can score scissor *or any headless agent*,
so a head-to-head is apples-to-apples.

```bash
scissor bench                         # scissor, default provider
scissor bench --list                  # list benchmark tasks
scissor bench -p all --json evals/bench.json
npm run bench                         # dev shortcut
```

Compare against [goose](https://github.com/block/goose) (or any CLI agent):

```bash
# goose must be on PATH and have a provider configured (`goose configure`).
scissor bench --agent goose

# any other headless agent via a command template ({PROMPT} is substituted):
scissor bench --agent custom --agent-cmd "mytool run --quiet -t {PROMPT}"
```

The external adapter runs the agent once per task inside the prepared workspace
(`goose run --no-session --quiet -t <prompt>` with `GOOSE_MODE=auto`), then
scores the resulting files / final answer with the same checks. External-agent
runs are POSIX-oriented (mac/Linux/WSL); on native Windows, run goose under WSL.

Latest scissor baseline (DeepSeek `deepseek-chat`): **5/5 (100%)**.

## MCP servers (external tools)

scissor has a built-in [Model Context Protocol](https://modelcontextprotocol.io/)
client, so you can extend the agent with any MCP server (browser automation,
desktop control, databases, issue trackers, ...) without writing tool code. This
is how scissor gets a browser/screenshot capability like Cursor's, and desktop
control on Windows.

Servers are configured in `~/.scissor/mcp.json` (Cursor-compatible), managed via:

```bash
scissor mcp add browser     # preset: Playwright MCP (npx @playwright/mcp) - navigate, click, screenshot
scissor mcp add desktop     # preset: Terminator (npx terminator-mcp-agent) - operate/screenshot Windows apps
scissor mcp add my-db --command uvx --arg my-db-mcp   # any stdio server
scissor mcp add remote --url https://host/mcp         # remote Streamable HTTP server
scissor mcp list            # show configured servers
scissor mcp test [name]     # connect and list the tools a server exposes
scissor mcp disable <name>  # keep the entry but don't connect it
```

At session start, scissor connects the enabled servers and exposes their tools
to the agent as `mcp_<server>_<tool>`. Notes:

- **Approval**: MCP tools run through the approval gate by default (external
  tools can be destructive, e.g. desktop control). Allowlist specific tools with
  `--auto-approve <tool>` on `mcp add`.
- **Screenshots/images** returned by a tool are saved under
  `.scissor/mcp-images/` in the workspace and the path is handed back to the
  agent (works with every provider, including non-vision ones).
- **Disable per session** with `--no-mcp` or `SCISSOR_NO_MCP=1`. A failing
  server never breaks the session; it is skipped with a warning.
- External-agent (npx) servers are POSIX-friendly and also run on Windows; the
  `.cmd` shim is resolved automatically.

## Test-first (TDD) mode

Run with `--tdd` (or set `"tddMode": true` in `~/.scissor/config.json`) to force
a red-green-refactor workflow:

```bash
scissor --tdd "add a retry helper with backoff"
```

When on, the agent must create/edit a **test file** before it is allowed to
write or edit a **source-code file** (attempts to edit source first are rejected
with guidance). The verification loop also runs the project's `test` script, so
correctness is proven, not assumed. Non-code files (docs, config, data) are never
gated.

## Safety model

By default scissor uses a **plan-gate** flow: for non-trivial work it presents a numbered plan, waits for your approval, then executes the steps. Genuinely destructive commands are always confirmed. File operations are constrained to the current working directory.

## Development

```bash
npm install
npm run typecheck     # non-emitting type check
npm run build         # tsup build (also used by the self-update verification gate)
npm test              # deterministic tests (session, supervisor, retrieval, verify, edits, compaction, memory, eval, bench, mcp, tdd)
npm run smoke         # real-LLM tool-loop smoke (needs a provider key)
npm run smoke:plan    # real-LLM plan-gate smoke
npm run smoke:restart # real-LLM restart_self smoke
npm run smoke:verify  # real-LLM verification closed-loop smoke
npm run smoke:edit    # real-LLM CRLF edit smoke
npm run smoke:compact # real-LLM context-compaction smoke
npm run eval          # real-LLM eval suite (scored, per-provider)
npm run bench         # harder benchmark suite (scissor / goose / custom agent)
npm run check         # the full gate: typecheck + build + test + eval --strict
```

### Pre-push gate

A git `pre-push` hook runs the full pipeline automatically on every `git push`
so quality is enforced without anyone remembering to run it:

```
typecheck → build → tests → eval suite (real-LLM, --strict)
```

The hook is installed automatically by the `prepare` script on `npm install`
(it copies `.githooks/pre-push` into `.git/hooks/`; run `node scripts/install-hooks.mjs`
to (re)install manually). The eval step needs a configured provider key.

Bypass when necessary:

- `SCISSOR_SKIP_EVAL=1 git push` — skip only the eval suite (still runs typecheck/build/tests).
- `git push --no-verify` — skip the hook entirely (discouraged).

## License

Personal use.
