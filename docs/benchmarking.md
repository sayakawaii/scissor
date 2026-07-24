# Benchmarking scissor's harness (vs a bare model call)

This is the runbook for the Databricks-style "does the scaffolding earn its keep"
comparison (OPEN_ITEMS §7d). It holds the **model fixed** and compares a bare
minimal harness against full scissor on the same tasks, reporting **pass rate +
tokens/task + est. cost/task** — repeated N times because LLM runs are stochastic.

All of this needs a reachable, keyed LLM provider. If your only provider is
DeepSeek and you're behind a proxy that blocks `api.deepseek.com` (or Node can't
use the proxy), these commands will report `0/…` with every call erroring — run
them from a network that can reach the provider.

## Quick reference (synthetic tasks, no external repo)

```bash
# bare vs full scissor on the built-in eval tasks (model held fixed)
scissor ab --candidate bare

# repeat 3x to see variance (mean/min/max/σ of tasks passed, mean tokens/cost)
scissor ab --candidate bare --runs 3

# which scaffolding earns its tokens? disable one component at a time
scissor ablate
```

The bench suite includes real-code-grounded tasks — e.g.
`omci-uint40-decode-bug` (a subtle big-endian 40-bit decode off-by-8 ported from
the iop-toolkit backend's `omciSchema/util.go`). Target it directly:

```bash
scissor ab --candidate bare --runs 3 -t omci-uint40-decode-bug
```

## Scheme A — retrieval QA on a real codebase (`iop-toolkit` backend)

Read-only questions over a real ~190-file Go service; each answer is a precise
token buried in one non-obvious file, so repo-map/retrieve should beat blind
grep. Zero toolchain (no build/test), scored by case-insensitive token match.

### 1. Build the source cache (one-time)

The tasks copy from a cached, code-only tree (default
`~/.scissor/iop-cache/backend`, override with `SCISSOR_IOP_BACKEND`). Rebuild it
from the checkout — e.g. from the WSL copy, filtered to source only:

```bash
# from WSL (writes to the Windows-side cache via /mnt/c)
cd /home/mingheh/project/iop-toolkit/backend
dest=/mnt/c/Users/mingheh/.scissor/iop-cache/backend
rm -rf "$dest" && mkdir -p "$dest"
find . -type f \( -name '*.go' -o -name '*.mod' -o -name '*.yaml' -o -name '*.yml' \) \
  -not -path '*/testdata/*' -not -path '*/testoutput/*' -not -path './docs/*' |
  while read f; do mkdir -p "$dest/$(dirname "$f")"; cp "$f" "$dest/$f"; done
```

Result: ~193 files / ~880 KB. Verify: `ls "$dest/go.mod"`.

### 2. Run the comparison

```bash
# smoke: two tasks, single run
scissor ab --candidate bare -t iop-module-name,iop-library-search-handler

# full signal: all 8 IOP tasks, 3 runs for variance
scissor ab --candidate bare --runs 3 -t \
  iop-module-name,iop-kafka-client,iop-web-framework,iop-library-search-handler,\
iop-omcianalyzer-request-handler,iop-sequencetracer-prefix,iop-kafka-topic-keys,\
iop-evtocd-deshape-file

# isolate the retrieval scaffolding's contribution
scissor ablate -t iop-module-name,iop-library-search-handler,iop-kafka-topic-keys,iop-evtocd-deshape-file
```

The IOP tasks are reachable only when named with `-t` (they depend on the
external tree), so they never run in the default `eval`/`bench` suite or the
pre-push gate.

### What to expect

On easy, guessable questions bare and scissor tie — but the discriminating
tasks (finding the *right* file among ~190: `LibrarySearch`, the topic keys, the
EVTOCD-deshape file, the sequence-tracer prefix) are where retrieve/repo-map
should reduce turns/tokens and lift pass rate. The `--runs 3` report surfaces the
mean pass delta and the tokens/cost ratio.

## Scheme B — real `go test` bug-fix (`go-uint40-decode-bug`)

A self-contained Go module (stdlib only) with the same 40-bit decode bug ported
from `omciSchema/util.go`, scored by a real `go test` red→green (independent
probe, so editing the on-disk test can't cheat). Unlike the hermetic bench
tasks, this exercises the actual Go toolchain.

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

## Distilled real historical bug (`omci-attr-slice-panic`)

Distilled from a real fix in the backend history — `omcianalyzer` commit
`d5f27be` *"fix(omciSchema): clamp table attribute slice to payload length"*.
Pre-fix, decoding a managed-entity schema sliced each attribute to its declared
size without clamping to the received payload, so a short payload (a proprietary
ME only present in the default schema) panicked with slice-out-of-range. Packaged
self-contained so a real `go test` goes red→green; scored by an independent probe
(fitting + overrunning schemas) plus a stub guard. Same Go/WSL bridge as Scheme B.

```bash
scissor ab --candidate bare --runs 3 -t omci-attr-slice-panic
```

To mine more: the per-service repos carry full history —
`omcianalyzer` (backend, richest: 227 commits), `webioptoolkit` (frontend),
`collector` (collector). Good candidates are single-file logic fixes with a clear
symptom in the message (`git log --grep=fix`). Tracked in OPEN_ITEMS §7d (D).
