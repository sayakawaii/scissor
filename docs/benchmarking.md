# Benchmarking scissor's harness (vs a bare model call)

This is the runbook for the Databricks-style "does the scaffolding earn its keep"
comparison (OPEN_ITEMS §7d). It holds the **model fixed** and compares a bare
minimal harness against full scissor on the same tasks, reporting **pass rate +
tokens/task + est. cost/task** — repeated N times because LLM runs are stochastic.

All of this needs a reachable, keyed LLM provider. If your only provider is
DeepSeek and you're behind a proxy that blocks `api.deepseek.com` (or Node can't
use the proxy), these commands will report `0/…` with every call erroring — run
them from a network that can reach the provider, or tunnel through a VPS (below).

## Reaching DeepSeek through a VPS (when the corporate proxy blocks it)

Our corporate proxy `10.144.1.10:8080` 403-blocks `api.deepseek.com` but *does*
allow `CONNECT` to a VPS we control (`64.176.54.200`), and the VPS reaches
DeepSeek fine. So we chain: **local Node → local CONNECT proxy → SSH tunnel
(through the corporate proxy) → VPS → DeepSeek**.

Two pieces make this work:

1. **A local CONNECT proxy backed by the SSH tunnel.** `~/.scissor/vps-proxy.py`
   (Python + paramiko) opens `CONNECT 64.176.54.200:22` through the corporate
   proxy, SSHs in with a password, and serves a local HTTP `CONNECT` proxy whose
   exit is the VPS — one SSH transport, one `direct-tcpip` channel per request.
   No software is installed on the VPS.

   ```bash
   # start it (password via env; never hard-code). Prints PROXY_READY when up.
   PY="/c/Users/mingheh/AppData/Local/Programs/Python/Python311/python.exe"
   VPS_PW='…' "$PY" ~/.scissor/vps-proxy.py proxy 8899 &
   # sanity: a real DeepSeek call from the VPS itself
   VPS_PW='…' "$PY" ~/.scissor/vps-proxy.py verify-deepseek
   ```

2. **Proxy-aware provider transport in scissor.** The OpenAI/Anthropic SDKs ship
   their own HTTP transport that ignores `*_PROXY`, so they went direct and timed
   out. scissor now hands the SDK Node's **built-in global `fetch`** (Node ≥ 24)
   whenever `NODE_USE_ENV_PROXY=1` is set — and that global fetch honors
   `HTTPS_PROXY`/`NO_PROXY` (`packages/core/src/providers/proxy.ts`). Zero change
   for normal direct runs (the switch is off by default).

Put together, run any scissor command through the VPS by prefixing:

```bash
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:8899 \
  node packages/cli/dist/index.js ab --candidate bare -t create-file
```

Notes:
- Both env vars are required: `HTTPS_PROXY` names the local tunnel, and
  `NODE_USE_ENV_PROXY=1` is what makes Node's global fetch (hence the provider)
  actually use it.
- The tunnel is a single SSH transport with many channels; the proxy keeps the
  socket alive (`set_keepalive(30)`) and does not reap idle tunnels, so long
  streaming completions survive.
- SSH port 22 to the VPS is only reachable *through* the corporate proxy here
  (direct 443/VLESS ports are blocked), which is why the helper dials the proxy's
  `CONNECT` rather than connecting to the VPS directly.

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
  real tasks (`iop-*`, `go-*`, `buried-bug-fix`, `deep-median-bug`,
  `omci-uint40-decode-bug`) all set `files: 1`, since their answer/fix lives in
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
