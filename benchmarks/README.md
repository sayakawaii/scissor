# benchmarks

Published provider/model comparisons produced by `scissor benchmark`. Unlike
`evals/` (machine-local run scratch, gitignored), everything here is committed
so a result can be reviewed, disputed and re-run.

Each run writes a pair of files sharing one basename:

- `<taskset>-n<runs>-<timestamp>.json` — the structured artifact: per-arm
  aggregates, per-task pass counts, pairwise verdicts and full provenance.
- `<taskset>-n<runs>-<timestamp>.md` — the same data as a readable report.

## What is measured

One arm is one *model*. The harness is held fixed across arms — same task set,
same scaffolding, same approval policy and timeout, model router off — so a
difference between arms is attributable to the model rather than to the agent
configuration around it.

Per arm the report carries pass rate with a 95% Wilson confidence interval,
tokens per task, estimated cost per task, turns per task, files per task, and
ACRR (over-reading against the oracle minimum, for tasks that carry one). It
also reports cost-normalized figures — cost per passing task and passing tasks
per dollar — because pass rate alone systematically rewards the most expensive
model.

## Reading the result honestly

The report declares a leader as *significant* only when its 95% Wilson interval
is disjoint from the runner-up's. Overlapping intervals are reported as
**inconclusive**, and the Markdown says so in those words. That is a
conservative screen rather than a formal two-proportion test: disjoint intervals
imply a real difference, but overlap does not prove equivalence.

Two further caveats are restated in every generated report. The Wilson interval
treats the N×tasks task-runs as independent Bernoulli trials, which they are not
— the same tasks recur and differ in difficulty — so true uncertainty is wider
than plotted; per-task pass counts are included so a reader can run a paired
test instead. And costs are estimates: provider-reported token counts times
public list prices on the date of the run, excluding cache and batch discounts.

## Reproducing a run

Every artifact records the scissor version, the git commit (flagged if the tree
was dirty), the Node major version and platform, the task ids, N, the timeout,
the harness settings, and the exact per-1M prices used. To repeat a published
run, check out the recorded commit and re-issue the command with the same arms,
task set and `--runs`.

```bash
# See the plan and the number of provider calls without spending anything.
scissor benchmark --arm nebius,deepseek --tasks eval --runs 5 --dry-run
```

Nothing machine-identifying is written here: no absolute paths, hostnames,
usernames or API keys. Raw per-task `detail` strings (which can embed temporary
directory paths) are aggregated away rather than copied into the artifact.
