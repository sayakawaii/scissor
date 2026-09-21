# Benchmarking scissor's harness (vs a bare model call)

This is the runbook for the Databricks-style "does the scaffolding earn its keep"
comparison (OPEN_ITEMS §7d). It holds the **model fixed** and compares a bare
minimal harness against full scissor on the same tasks, reporting **pass rate +
tokens/task + est. cost/task** — repeated N times because LLM runs are stochastic.

All of this needs a reachable, keyed LLM provider. If you're behind a proxy that
blocks your provider's API (or Node can't use the proxy), these commands will
report `0/…` with every call erroring — run them from a network that can reach
the provider, or route through a proxy you control (below).

## Running behind an HTTP proxy

The OpenAI/Anthropic SDKs ship their own HTTP transport that ignores `*_PROXY`,
so they go direct and time out behind a proxy. scissor hands the SDK Node's
**built-in global `fetch`** (Node ≥ 24) whenever `NODE_USE_ENV_PROXY=1` is set,
and that global fetch honors `HTTPS_PROXY`/`NO_PROXY`
(`packages/core/src/providers/proxy.ts`). The switch is off by default, so normal
direct runs are unchanged.

```bash
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:8899 \
  node packages/cli/dist/index.js ab --candidate bare -t create-file
```

Both env vars are required: `HTTPS_PROXY` names the proxy, and
`NODE_USE_ENV_PROXY=1` is what makes Node's global fetch (hence the provider)
actually use it.

## Quick reference (synthetic tasks, no external repo)

```bash
# bare vs full scissor on the built-in eval tasks (model held fixed)
scissor ab --candidate bare

# repeat 3x to see variance (mean/min/max/σ of tasks passed, mean tokens/cost)
scissor ab --candidate bare --runs 3

# which scaffolding earns its tokens? disable one component at a time
scissor ablate
```

The bench suite includes harder, realistically-shaped tasks — e.g.
`tlv-uint40-decode-bug` (a subtle big-endian 40-bit decode off-by-8 buried in a
multi-package tree). Target it directly:

```bash
scissor ab --candidate bare --runs 3 -t tlv-uint40-decode-bug
```

## Reading the over-reading (ACRR) numbers

Beyond pass/tokens/cost, `ab` and `ablate` now report an **over-reading** view
grounded in Yin & Feng, *"Do AI Agents Know When a Task Is Simple?"*
(arXiv:2607.13034): the **files/task** an arm pulls into context, and the
**ACRR** (Agent Cognitive Redundancy Ratio) = `(files_actual − files_min) /
files_min` against each task's oracle minimum. `0` ≈ oracle-lean; `1` ≈ read
twice the minimum; higher ≈ more over-reading.

```
  files/task: bare 1.2  →  scissor 4.1   (3.42x more)
  over-read (ACRR files): bare 0.20  →  scissor 3.10   min 1.0 file/task
```

- Only tasks annotated with an `oracle` (min files) contribute to ACRR — the
  real tasks (`go-*`, `buried-bug-fix`, `deep-median-bug`,
  `tlv-uint40-decode-bug`) all set `files: 1`, since their answer/fix lives in
  one file. Files are a proxy: distinct paths passed to `read_file`/`edit_file`/
  `write_file`.
- In `scissor ablate`, the matrix gains a **files/task** column, so you can see
  which component (repo-map / retrieve) is responsible for the extra reads — a
  large files drop with a **`(=)`** pass delta means it spent reads for no gain
  on these tasks. This is the Phase-0 measurement (OPEN_ITEMS §7e) that decides
  whether an E3-style scope estimator is worth building. Expect the effect to be
  **real but modest** on a frontier model, exactly as the paper's LLM-Case found.

## Acting on the estimate (E3 Execute — `SCISSOR_ESTIMATE_EXECUTE`)

Phase 1 only *records* the scope estimate `x₀`; **Phase 2** acts on it. With
`SCISSOR_ESTIMATE_EXECUTE=1`, a guardrail runs the paper's level-1 fast path: on
a *confident localized* estimate (`difficulty:1 / scope:local / confidence≥0.7`
— i.e. the request names a file or quoted symbol and a small change) it skips the
broad semantic `retrieve` tool and tells the agent to read the named file
directly. It is conservative by design — vague "find the bug somewhere" prompts
estimate as `difficulty:2` and keep full retrieval, and a run that starts local
but touches many sites is left alone for the (upcoming) Expand stage.

Off by default, so the default agent and the eval gate are unchanged. To measure
the token / over-reading delta at equal pass rate on a genuinely localized task:

```bash
# baseline (full context) vs. minimum-viable path, same task
scissor ab --candidate scissor -t edit-json --runs 3
SCISSOR_ESTIMATE_EXECUTE=1 scissor ab --candidate scissor -t edit-json --runs 3
```

A win looks like: same pass rate, fewer `files/task` and lower `over-read (ACRR
files)`, fewer tokens. If pass rate drops, the estimator was over-confident on
that task — tighten the cues in `estimator.ts` or lower the confidence gate.

## Scheme B — real `go test` bug-fix (`go-uint40-decode-bug`)

A self-contained Go module (stdlib only) with the same 40-bit decode bug, scored
by a real `go test` red→green (independent probe, so editing the on-disk test
can't cheat). Unlike the hermetic bench tasks, this exercises the actual Go
toolchain.

Needs a Go toolchain. scissor bridges to it: on Windows it runs `go` inside WSL
against the workspace's `/mnt/<drive>` mount, offline (`GOPROXY=off`). Point
`SCISSOR_GO_BIN` at the dir holding the `go` binary if it isn't at
`/usr/local/go/bin`.

```bash
# bare vs scissor on the real Go task (3 runs for variance)
scissor ab --candidate bare --runs 3 -t go-uint40-decode-bug
```

## Scheme C — verify-loop ablation on the Go task

scissor's verify loop auto-detects Node projects only, so for Go you wire it
explicitly via `SCISSOR_VERIFY_COMMANDS` (build then test, `;`-separated). Then
`ablate` measures what the verify loop is worth: the reference runs with verify
on, the `verify-loop` arm turns it off (`SCISSOR_NO_VERIFY=1`). This is cleanest
when scissor runs where `go` is on PATH (e.g. inside WSL).

```bash
export SCISSOR_VERIFY_COMMANDS="go build ./...;go test ./..."
scissor ablate -t go-uint40-decode-bug
# → matrix row `verify-loop` shows the pass/token/cost delta from turning the
#   closed loop off on a real, non-Node project.
```

## Schema clamp bug (`tlv-attr-slice-panic`)

Decoding a record schema slices each field to its declared size without clamping
to the received payload, so a short payload (a record type only present in the
default schema) panics with slice-out-of-range. Packaged self-contained so a real
`go test` goes red→green; scored by an independent probe (fitting + overrunning
schemas) plus a stub guard. Same Go/WSL bridge as Scheme B.

```bash
scissor ab --candidate bare --runs 3 -t tlv-attr-slice-panic
```
