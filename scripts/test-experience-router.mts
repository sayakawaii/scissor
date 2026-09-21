/**
 * Deterministic test: restricted auto-router (doc §5 Phase 4 受限自动路由).
 *
 * Covers, with no network, every safety control the doc requires:
 *  - feature flag: mode "off" is a hard no-op;
 *  - allowlist only: no matching rule => allow (fallback);
 *  - per-option kill switch: excluded ids are never routed;
 *  - confidence threshold: thin/low-confidence cells => allow;
 *  - reliability gap + "from must look unreliable" gates;
 *  - deflection: a confident unreliable->reliable route is chosen;
 *  - guard behavior: shadow allows but records the decision; enforce blocks with
 *    a NON-error steering message; off records nothing.
 *
 * Run: node --import tsx scripts/test-experience-router.mts
 */
import assert from "node:assert/strict";
import {
  aggregateExperience,
  createExperienceRouterGuard,
  decideRoute,
  EXPERIENCE_SCHEMA_VERSION,
  type ExperienceEvent,
  type ExperienceReport,
  type ExperienceRouterConfig,
  type RouteContext,
  type RouteVerdict,
  type ToolCall,
} from "@scissor/core";

let n = 0;
const ts = (i: number): string => `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`;
function ev(option: string, termination: ExperienceEvent["termination"], sig?: string): ExperienceEvent {
  return {
    schemaVersion: EXPERIENCE_SCHEMA_VERSION,
    taskId: `t${n}`,
    option: { id: option, version: "m1" },
    state: { lang: "node" },
    startedAt: ts(n++),
    durationMs: 100,
    termination,
    evidence: sig ? { errorSignature: sig } : {},
    cost: {},
  };
}

// Build a report in state lang=node, version m1:
//   grep       1/6  (unreliable, confident)
//   retrieve   6/6  (reliable,   confident)
//   glob       2/3  (not confident — thin sample)
//   mid_from   3/6  (0.50, confident)
//   mid_to     4/6  (0.67, confident)
const events: ExperienceEvent[] = [];
events.push(ev("grep", "success"));
for (let i = 0; i < 5; i++) events.push(ev("grep", "failure", "no matches <x>"));
for (let i = 0; i < 6; i++) events.push(ev("retrieve", "success"));
events.push(ev("glob", "success"), ev("glob", "success"), ev("glob", "failure"));
for (let i = 0; i < 3; i++) events.push(ev("mid_from", "success"));
for (let i = 0; i < 3; i++) events.push(ev("mid_from", "failure"));
for (let i = 0; i < 4; i++) events.push(ev("mid_to", "success"));
for (let i = 0; i < 2; i++) events.push(ev("mid_to", "failure"));

const report: ExperienceReport = aggregateExperience(events);
const state = { lang: "node" };
const call = (name: string): ToolCall => ({ id: "c1", name, arguments: {} });

function ctx(config: Partial<ExperienceRouterConfig>): RouteContext {
  return {
    report,
    state,
    config: {
      mode: "enforce",
      rules: [{ from: "grep", to: "retrieve" }],
      version: "m1",
      gap: 0.25,
      maxFromRate: 0.6,
      ...config,
    },
  };
}

// 1. Deflect: confident unreliable grep -> reliable retrieve.
{
  const d = decideRoute(call("grep"), ctx({}));
  assert.equal(d.action, "deflect");
  assert.equal(d.from, "grep");
  assert.equal(d.to, "retrieve");
  assert.ok((d.fromRate ?? 1) < 0.25 && (d.toRate ?? 0) > 0.9, "evidence carried");
  assert.equal(d.stateBucket, "lang=node");
}

// 2. Feature flag: off is a no-op.
{
  const d = decideRoute(call("grep"), ctx({ mode: "off" }));
  assert.equal(d.action, "allow");
  assert.match(d.reason, /off/);
}

// 3. Kill switch: grep excluded -> allow.
{
  const d = decideRoute(call("grep"), ctx({ killSwitch: ["grep"] }));
  assert.equal(d.action, "allow");
  assert.match(d.reason, /kill-switch/);
}

// 4. Allowlist only: a tool with no rule is never routed.
{
  const d = decideRoute(call("read_file"), ctx({}));
  assert.equal(d.action, "allow");
  assert.match(d.reason, /no matching route rule/);
}

// 5. Insufficient data: target has no cell -> allow.
{
  const d = decideRoute(call("grep"), ctx({ rules: [{ from: "grep", to: "nonexistent" }] }));
  assert.equal(d.action, "allow");
  assert.match(d.reason, /insufficient data/);
}

// 6. Confidence threshold: thin `from` (glob 2/3) -> allow.
{
  const d = decideRoute(call("glob"), ctx({ rules: [{ from: "glob", to: "retrieve" }] }));
  assert.equal(d.action, "allow");
  assert.match(d.reason, /insufficient confidence/);
}

// 7. `from` not unreliable enough (retrieve 6/6) -> allow.
{
  const d = decideRoute(call("retrieve"), ctx({ rules: [{ from: "retrieve", to: "grep" }] }));
  assert.equal(d.action, "allow");
  assert.match(d.reason, /not unreliable enough/);
}

// 8. Reliability gap below threshold (mid_from 0.50 -> mid_to 0.67, gap 0.17).
{
  const d = decideRoute(call("mid_from"), ctx({ rules: [{ from: "mid_from", to: "mid_to" }] }));
  assert.equal(d.action, "allow");
  assert.match(d.reason, /gap below threshold/);
}

// 9. Guard — shadow: allows but records the decision.
{
  const decisions: RouteVerdict[] = [];
  const guard = createExperienceRouterGuard(ctx({ mode: "shadow" }), {
    onDecision: (d) => decisions.push(d),
  });
  const verdict = await guard.beforeTool!(call("grep"), {} as never);
  assert.equal(verdict.allow, true, "shadow never overrides");
  assert.equal(decisions.length, 1, "shadow records the would-be route");
  assert.equal(decisions[0]!.to, "retrieve");
}

// 10. Guard — enforce: blocks with a non-error steering message.
{
  const decisions: RouteVerdict[] = [];
  const guard = createExperienceRouterGuard(ctx({ mode: "enforce" }), {
    onDecision: (d) => decisions.push(d),
  });
  const verdict = await guard.beforeTool!(call("grep"), {} as never);
  assert.equal(verdict.allow, false, "enforce deflects");
  if (!verdict.allow) {
    assert.equal(verdict.result?.isError, false, "steering is not a hard error");
    assert.ok(verdict.result?.content.includes("retrieve"), "names the alternative");
  }
  assert.equal(decisions.length, 1, "enforce records the route");
}

// 11. Guard — off: no decision recorded, always allows.
{
  const decisions: RouteVerdict[] = [];
  const guard = createExperienceRouterGuard(ctx({ mode: "off" }), {
    onDecision: (d) => decisions.push(d),
  });
  const verdict = await guard.beforeTool!(call("grep"), {} as never);
  assert.equal(verdict.allow, true);
  assert.equal(decisions.length, 0, "off records nothing");
}

// 12. Guard — enforce but non-rule tool: passes through untouched.
{
  const decisions: RouteVerdict[] = [];
  const guard = createExperienceRouterGuard(ctx({ mode: "enforce" }), {
    onDecision: (d) => decisions.push(d),
  });
  const verdict = await guard.beforeTool!(call("read_file"), {} as never);
  assert.equal(verdict.allow, true);
  assert.equal(decisions.length, 0);
}

process.stdout.write("test-experience-router: ALL PASS\n");
