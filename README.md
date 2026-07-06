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

REPL slash commands: `/help`, `/reset`, `/compact`, `/remember <fact>`, `/info`, `/exit`.

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

## Reliable edits

`edit_file` uses a tolerant matching engine so small mismatches don't waste a
turn:

- Line-ending (CRLF/LF) and trailing-whitespace differences are tolerated, as
  are stray leading/trailing blank lines — but a fuzzy match is only applied when
  it is unique, and unchanged lines keep their exact original formatting.
- `replace_all` replaces every occurrence; otherwise a match must be unique.
- Pass an `edits` array to make several changes to one file atomically.
- On a miss, the error points at the closest matching line so the retry is cheap.

## Sessions & memory

Every REPL/one-shot run is saved to `~/.scissor/sessions/<id>.json` (transcript +
metadata). List them with `scissor sessions` and continue one with
`scissor --resume <id>`. A `SCISSOR_MEMORY.md` file in the workspace, if present,
is injected into the system prompt as long-term memory.

**Long-term memory:** the agent can save durable facts (conventions, key
commands, gotchas) to `SCISSOR_MEMORY.md` via the `remember` tool, or you can add
one yourself with `/remember <fact>`. These are loaded into context in future
sessions.

**Context compaction:** when a conversation grows past a threshold, scissor
summarizes the oldest rounds into a rolling "summary of earlier conversation"
note (via the LLM) instead of dropping them, so long sessions keep their context.
Trigger it manually with `/compact`.

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
  build (type-check + build), and either reloads into it or **rolls back** to the
  last working version automatically.
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

## Safety model

By default scissor uses a **plan-gate** flow: for non-trivial work it presents a numbered plan, waits for your approval, then executes the steps. Genuinely destructive commands are always confirmed. File operations are constrained to the current working directory.

## Development

```bash
npm install
npm run typecheck     # non-emitting type check
npm run build         # tsup build (also used by the self-update verification gate)
npm test              # deterministic tests (session, supervisor, retrieval, verify, edits, compaction, memory)
npm run smoke         # real-LLM tool-loop smoke (needs a provider key)
npm run smoke:plan    # real-LLM plan-gate smoke
npm run smoke:restart # real-LLM restart_self smoke
npm run smoke:verify  # real-LLM verification closed-loop smoke
npm run smoke:edit    # real-LLM CRLF edit smoke
npm run smoke:compact # real-LLM context-compaction smoke
npm run eval          # real-LLM eval suite (scored, per-provider)
```

## License

Personal use.
