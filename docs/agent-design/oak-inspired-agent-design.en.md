# OaK-Inspired Agent Design for Scissor

> Goal: translate ideas from Richard Sutton's OaK—Options and Knowledge—into an incremental, testable, and reversible engineering design for Scissor.
> Boundary: this is an OaK-inspired coding-agent architecture. It does not claim that Scissor implements, or will fully implement, OaK.

[中文版](./oak-inspired-agent-design.md)

## 1. Core Assessment

Scissor already has useful foundations for an OaK-like engineering loop:

- `AgentCallbacks` and tool calls provide an observation/action interface;
- the guardrail pipeline expresses permissions, safety, and execution constraints;
- tests, typechecking, linting, evals, and benchmarks provide observable outcomes;
- the scratchpad, session archive, and `SCISSOR_MEMORY.md` provide state at different time scales;
- tools, skills, subagents, and control tools can serve as engineering approximations of options;
- tracing, cost reports, and eval generation already collect execution experience.

However, Scissor remains a "frozen LLM + in-context adaptation + external state" agent rather than OaK in Sutton's sense. Its most important gaps are:

- no explicit, continually learned value function;
- no experience-based model of option success conditions and consequences;
- no automatic discovery of reward-respecting subproblems from state features;
- no long-term utility-based curation of skills, memories, and subagents;
- no continual update of the base model's weights and representations from first-person experience.

The practical goal should not be to reproduce the complete research architecture. It should be to build a safe **OaK-inspired experience layer** that turns real execution traces into structured features, capability statistics, and planning evidence.

## 2. Design Principles

### 2.1 Separate the Primary Objective from Hard Constraints

Permissions, safety, data integrity, and user approval must not be compressed into a score that other gains can offset.

- **Primary objective**: the final result requested by the user.
- **Success evidence**: tests, builds, lint results, files, and command output.
- **Cost signals**: tokens, elapsed time, tool calls, and failed retries.
- **Hard constraints**: permissions, approvals, path boundaries, irreversible operations, and secrets.

Guardrails always take precedence over optimization. No learned behavior may relax hard constraints on its own.

### 2.2 Subtasks Must Be Reward-Respecting

Every subtask must state how it improves the probability of achieving the parent goal. Local completion alone is not sufficient.

Planner-generated subtasks should include:

- `parentGoalId`
- `expectedContribution`
- `successEvidence`
- `constraints`
- `budget`
- `terminationCondition`

If a task cannot explain its expected contribution, it should not be created, or it should be downgraded to an exploratory candidate.

### 2.3 Skills Should Have Option Semantics

An OaK option consists of a policy plus a termination condition. Scissor's tools, skills, and subagents can adopt an analogous contract:

- **initiation**: the states in which the capability applies;
- **policy**: recommended steps or permitted tools;
- **success termination**: the evidence that ends the option successfully;
- **failure termination**: failure, timeout, budget exhaustion, or rising risk;
- **expected outcome**: the state features expected to change;
- **evidence**: how the outcome is verified rather than accepted from model text.

This is an engineering abstraction. It does not imply that the policy was learned through reinforcement learning.

### 2.4 Reobserve at Every Option Boundary

A long-range plan should not be treated as an immutable script. After every skill or subagent:

1. reread the relevant state;
2. inspect success evidence;
3. update cost and risk;
4. continue, terminate, roll back, or replan.

This limits cascading failures caused by an incorrect early assumption.

### 2.5 Curate Capabilities by Demonstrated Utility

Memories, skills, and workflows should not accumulate indefinitely. Retention should depend on demonstrated contribution to final task outcomes, not invocation count.

Useful signals include:

- the project states in which a capability improves success rate;
- whether it reduces turns, tokens, time, or retries;
- whether it reduces verification failures and user corrections;
- whether the result reproduces across tasks;
- whether it introduces safety risk or maintenance cost.

## 3. Proposed Architecture

### 3.1 State Feature Extractor

Extract stable, comparable, structured state from existing context:

- **repository**: languages, frameworks, package manager, workspace size, and git status;
- **task**: intent, target files, risk level, and whether user input is required;
- **execution**: recent tool results, error types, retry count, and remaining budget;
- **verification**: typecheck, lint, test, and eval outcomes and failure signatures;
- **history**: options that succeeded or failed on similar tasks.

The first version should use deterministic rules and existing trace data. It should not introduce a vector database or online training dependency.

### 3.2 Subproblem Selector

Given the primary goal and state features, produce a small number of candidate subtasks. Every candidate must include its expected contribution and termination condition.

Prefer subtasks that:

- have a clear causal path to final success;
- are valuable only in the current state rather than mechanically run for every task;
- produce decision-relevant information or reduce material risk;
- produce verifiable artifacts.

Limit the candidate count so that open-ended discovery does not become uncontrolled expansion.

### 3.3 Option Registry

Maintain shared metadata above the existing tools, control tools, skills, and subagents:

- `id`, `version`, `description`
- `applicableWhen`
- `requiredCapabilities`
- `termination`
- `expectedFeatures`
- `verification`
- `risk`
- `utilityStats`

The registry stores metadata and statistics only. Execution remains in the current agent loop and continues through the guardrail pipeline.

### 3.4 Experience Model

Derive `(state, option, outcome)` records from traces and estimate which capabilities are likely to work in which states.

Do not start with a neural network. Initial methods can include:

- buckets based on stable features;
- Beta/Bernoulli success-rate estimation;
- exponentially decayed latency and cost averages;
- failure-signature counts;
- minimum sample thresholds and confidence intervals;
- isolated statistics for each option version.

This is not a complete transition model, but it gives planning an explainable and testable empirical prior.

### 3.5 Planner

Option scoring should consider:

- expected contribution to the primary objective;
- probability of success;
- token, time, and tool cost;
- risk and reversibility;
- information gain;
- whether sufficient success evidence already exists.

The planner may select only options allowed by guardrails. High-risk and destructive actions still require user approval.

### 3.6 Utility Curator

Periodically evaluate options, memories, and generated rules:

- clear benefit with sufficient evidence: retain or raise priority;
- duplicate function: merge;
- no long-term contribution: demote or archive;
- incompatibility with a new version: invalidate;
- privilege expansion, loops, or verification regressions: disable immediately and record the reason.

Automatic deletion should be conservative. The first version should generate recommendations that require human confirmation.

## 4. Mapping to Existing Scissor Modules

### `packages/core`

- `agent.ts`: keep the main loop small; consume structured planner decisions without embedding policy rules in the loop.
- `guardrails/**`: continue to own cross-tool safety policy; the experience model must not bypass it.
- `tools/**`: optionally add initiation, outcome, and verification metadata.
- `prompt.ts` / `repo-index.ts`: provide inputs to state feature extraction without injecting entire raw traces into the prompt.
- `session-store`: persist structured goals, subtasks, and current option state.

### `packages/cli`

- `trace/**`: add a stable schema for option id/version, preconditions, termination reason, and verification result.
- `eval` / `bench`: measure whether experience-based routing improves pass rate rather than merely reducing token usage.
- `self/**`: preserve an independent safety boundary; the learning layer must not modify or bypass the supervisor.
- UI: show why an option was selected, its confidence, expected cost, and termination condition.

### Suggested New Core Boundary

Incrementally add the following under `packages/core`:

- `experience/features.ts`
- `experience/option-registry.ts`
- `experience/model.ts`
- `experience/planner.ts`
- `experience/curator.ts`

These modules should depend only on structured data, not terminal UI. Persistence should remain local JSON/JSONL to preserve Scissor's local-first, minimal-dependency design.

## 5. Incremental Delivery Plan

### Phase 0: Define Testable Objectives First

Add benchmark or eval cases that distinguish the new behavior from the old behavior:

- switch to a more appropriate diagnostic option when the same failure repeats;
- avoid repeating expensive work when sufficient verification evidence already exists;
- do not invoke a skill when its initiation conditions do not hold;
- treat a locally successful subtask as a failure if it damages the parent goal;
- safely fall back to the existing planner when experience is insufficient.

Prioritize metrics in this order:

1. real-task autonomy;
2. reliability;
3. harder-benchmark pass rate;
4. cost and speed, but only when the first three do not regress.

### Phase 1: Normalize Traces

Improve observability without changing decisions:

- assign a stable option id to every tool, skill, and subagent execution;
- record precondition features, outcome, termination reason, verification result, latency, and tokens;
- remove paths, secrets, and user content that should not be retained;
- version the schema so old traces can be migrated or safely ignored.

### Phase 2: Offline Experience Report

Generate a read-only report from traces:

- option success rates under different states;
- dominant failure signatures;
- average cost and latency;
- correlation with final task success;
- sample size and confidence.

Let people validate the statistics before using them for online decisions.

### Phase 3: Advisory Mode

The experience model ranks options and explains the ranking, but the existing strategy remains authoritative. Record whether following the recommendation improves outcomes to avoid self-reinforcing offline metrics.

### Phase 4: Constrained Automatic Routing

Automatically choose only low-risk, reversible options with sufficient evidence. Require:

- a feature flag;
- a per-option kill switch;
- confidence thresholds;
- drift detection;
- fallback to the existing planner;
- A/B or shadow evaluation.

### Phase 5: Controlled Capability Curation

The system may recommend merging, demoting, or archiving a skill, but it may not automatically change permissions or hard constraints. Every generated skill must pass deterministic tests or evals before activation.

## 6. Minimal Data Model

```ts
type ExperienceEvent = {
  schemaVersion: 1;
  taskId: string;
  option: { id: string; version: string };
  state: Record<string, string | number | boolean>;
  startedAt: string;
  durationMs: number;
  termination: "success" | "failure" | "cancelled" | "budget" | "guardrail";
  evidence: {
    verificationPassed?: boolean;
    errorSignature?: string;
    changedFiles?: number;
  };
  cost: { inputTokens?: number; outputTokens?: number; usd?: number };
  finalTaskOutcome?: "success" | "failure" | "unknown";
};
```

State features must have low cardinality, remain stable, and exclude secrets. Free text should be reduced to normalized error signatures or hashes so the experience store does not become a repository of private data.

## 7. Failure Modes and Safeguards

### Reward Hacking

Optimizing only for "tests pass" may encourage deleting tests or weakening assertions. Protect test integrity, user constraints, and diff quality independently, with hard rules enforced by guardrails.

### Local KPIs That Damage the Parent Goal

A subagent may complete its file edit while breaking the build or violating the requirement. Utility must ultimately be determined by parent-task verification.

### Contaminated Data

User interruption, environment failures, and denied permissions should not be recorded as ordinary option failures. The termination reason must distinguish them.

### Non-Stationarity and Version Drift

Statistics may become invalid after model, prompt, tool, or project changes. Partition data by version, apply time decay, and require minimum sample sizes.

### Premature Automation

Correlation from a small sample is not causation. Follow the sequence: observe → report → advise → constrained automation.

### Capability-Library Growth

Set capacity limits, detect duplicates, require minimum utility, and retain human review. Every new option needs success evidence and a termination condition.

## 8. Recommended First Implementation Slice

Implement **trace normalization plus an offline option-utility report** first, without changing agent decisions.

Benefits:

- directly reuses Scissor's traces, evals, and benchmarks;
- leaves the agent loop and safety boundaries unchanged;
- tests whether the experience data contains a useful signal;
- supports deterministic regression tests;
- can be abandoned cheaply if the data proves unhelpful.

Acceptance criteria:

1. Traces reliably connect state, option, termination, and final verification outcome.
2. Reports expose sample size and confidence.
3. Sensitive text does not enter the experience data.
4. A fixed fixture produces deterministic output.
5. A new benchmark proves that the report identifies an option that is substantially more reliable in a particular state.
6. Existing Agent behavior and benchmark pass rates remain unchanged.

## 9. Explicit Non-Goals

- Do not let the Agent modify top-level objectives, permissions, or guardrails.
- Do not relabel every tool call as "reinforcement learning."
- Do not add neural networks, vector databases, or online weight training before the data demonstrates a need.
- Do not use skill invocation count as utility.
- Do not claim that frozen-LLM planning is equivalent to OaK continual learning.
- Do not rewrite the stable agent loop merely because the concepts appear similar.

## References

- [WAIC 2026 OaK talk analysis](../research/waic-2026-oak-analysis.en.md)
- [The Alberta Plan for AI Research](https://arxiv.org/abs/2208.11173)
- [Reward-respecting Subtasks](https://arxiv.org/abs/2202.03466)
- [OaK Architecture — Rich Sutton, RLC 2025](https://www.amii.ca/videos/oak-architecture-rich-sutton-rlc2025)
