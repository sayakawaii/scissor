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

REPL slash commands: `/help`, `/reset`, `/info`, `/exit`.

## Safety model

By default scissor uses a **plan-gate** flow: for non-trivial work it presents a numbered plan, waits for your approval, then executes the steps. Genuinely destructive commands are always confirmed. File operations are constrained to the current working directory.

## License

Personal use.
