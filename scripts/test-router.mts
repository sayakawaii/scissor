/**
 * Deterministic test: the heuristic model router.
 * Covers routeTurn scoring (cheap vs strong), verify-fail escalation, the
 * RouterProvider dispatch, an end-to-end Agent run that escalates after a
 * failed verification, tier resolution defaults, and graceful degradation when
 * the strong tier has no API key. No network.
 *
 * Run: node --import tsx scripts/test-router.mts
 */
import assert from "node:assert/strict";
import os from "node:os";
import {
  Agent,
  createRoutedProvider,
  DEFAULT_ROUTE_THRESHOLD,
  resolveRouterTiers,
  RouterProvider,
  routeTurn,
  type ChatParams,
  type ChatResult,
  type LLMProvider,
  type Message,
  type ProviderId,
  type ScissorConfig,
} from "@scissor/core";

const user = (content: string): Message => ({ role: "user", content });
const T = DEFAULT_ROUTE_THRESHOLD;

// 1. A short, simple request routes to the cheap tier.
{
  const d = routeTurn({
    messages: [user("create a file hello.txt with the text hi")],
    threshold: T,
    escalateOnVerifyFail: true,
  });
  assert.equal(d.tier, "cheap", "simple request -> cheap");
  assert.equal(d.score, 0);
}

// 2. A complex-intent keyword (EN) escalates on its own.
{
  const d = routeTurn({
    messages: [user("please refactor the auth module")],
    threshold: T,
    escalateOnVerifyFail: true,
  });
  assert.equal(d.tier, "strong", "refactor -> strong");
  assert.ok(d.reasons.includes("complex-intent"));
}

// 3. A complex-intent keyword (ZH) escalates too.
{
  const d = routeTurn({
    messages: [user("帮我调试这个并发死锁问题")],
    threshold: T,
    escalateOnVerifyFail: true,
  });
  assert.equal(d.tier, "strong", "调试 -> strong");
}

// 4. A failed verification on the previous turn escalates.
{
  const d = routeTurn({
    messages: [
      user("add a helper function"),
      { role: "assistant", content: "done" },
      user("[automated verification] typecheck failed\nTS2322: type error"),
    ],
    threshold: T,
    escalateOnVerifyFail: true,
  });
  assert.equal(d.tier, "strong", "verify-fail -> strong");
  assert.ok(d.reasons.includes("verify-failed"));
}

// 5. escalateOnVerifyFail:false disables that signal.
{
  const d = routeTurn({
    messages: [
      user("add a helper function"),
      user("[automated verification] typecheck failed"),
    ],
    threshold: T,
    escalateOnVerifyFail: false,
  });
  assert.equal(d.tier, "cheap", "verify-fail ignored when disabled");
}

// 6. Large context alone scores 2 (below threshold) -> cheap, but with a long
//    running turn (>=4 assistant messages) it crosses to strong.
{
  const big = user("x".repeat(13_000));
  const d1 = routeTurn({ messages: [big], threshold: T, escalateOnVerifyFail: true });
  assert.equal(d1.tier, "cheap", "large-context alone stays cheap");
  assert.ok(d1.reasons.includes("large-context"));

  const withTurns: Message[] = [
    big,
    { role: "assistant", content: "a" },
    { role: "assistant", content: "b" },
    { role: "assistant", content: "c" },
    { role: "assistant", content: "d" },
  ];
  const d2 = routeTurn({ messages: withTurns, threshold: T, escalateOnVerifyFail: true });
  assert.equal(d2.tier, "strong", "large-context + long-turn -> strong");
}

// 7. RouterProvider dispatches to the right underlying provider.
{
  class Spy implements LLMProvider {
    calls = 0;
    constructor(readonly id: ProviderId, readonly model: string) {}
    async chat(_p: ChatParams): Promise<ChatResult> {
      this.calls++;
      return { text: this.model, toolCalls: [] };
    }
  }
  const cheap = new Spy("deepseek", "deepseek-chat");
  const strong = new Spy("deepseek", "deepseek-reasoner");
  const routes: string[] = [];
  const router = new RouterProvider({
    cheap: { provider: cheap, label: "deepseek:deepseek-chat" },
    strong: { provider: strong, label: "deepseek:deepseek-reasoner" },
    onRoute: (d) => routes.push(d.tier),
  });

  await router.chat({ messages: [user("write a hello world")] });
  assert.equal(cheap.calls, 1, "cheap turn dispatched to cheap");
  assert.equal(strong.calls, 0);

  await router.chat({ messages: [user("refactor everything")] });
  assert.equal(strong.calls, 1, "hard turn dispatched to strong");
  assert.deepEqual(routes, ["cheap", "strong"]);
  assert.match(router.model, /router\(deepseek:deepseek-chat \| deepseek:deepseek-reasoner\)/);
}

// 8. End-to-end: an Agent whose provider is the router sends simple requests to
//    the cheap tier and complex-intent requests to the strong tier.
{
  class TieredSpy implements LLMProvider {
    constructor(
      readonly id: ProviderId,
      readonly model: string,
      private readonly onTurn: () => void,
    ) {}
    async chat(_p: ChatParams): Promise<ChatResult> {
      this.onTurn();
      return { text: "ok", toolCalls: [] };
    }
  }
  const order: string[] = [];
  const cheap = new TieredSpy("deepseek", "cheap", () => order.push("cheap"));
  const strong = new TieredSpy("deepseek", "strong", () => order.push("strong"));
  const router = new RouterProvider({
    cheap: { provider: cheap, label: "cheap" },
    strong: { provider: strong, label: "strong" },
  });
  const agent = new Agent({
    provider: router,
    tools: [],
    workspaceRoot: os.tmpdir(),
    approvalPolicy: "auto",
    systemPrompt: "sys",
  });

  await agent.run("list the files here");
  agent.reset();
  await agent.run("refactor the whole module for better architecture");
  assert.deepEqual(order, ["cheap", "strong"], "agent routes by turn difficulty");
}

// 9. Tier resolution defaults: base deepseek -> cheap chat / strong reasoner.
{
  const config: ScissorConfig = {
    defaultProvider: "deepseek",
    providers: { deepseek: { apiKey: "x" } },
    router: { enabled: true },
  };
  const tiers = resolveRouterTiers(config, "deepseek");
  assert.equal(tiers.cheap.provider, "deepseek");
  assert.equal(tiers.cheap.model, "deepseek-chat");
  assert.equal(tiers.strong.provider, "deepseek");
  assert.equal(tiers.strong.model, "deepseek-reasoner");
  assert.equal(tiers.threshold, 3);
  assert.equal(tiers.escalateOnVerifyFail, true);
}

// 10. createRoutedProvider degrades gracefully when the strong tier lacks a key.
{
  const config: ScissorConfig = {
    defaultProvider: "deepseek",
    providers: { deepseek: { apiKey: "x" } }, // no claude key
    router: { enabled: true, strong: { provider: "claude" } },
  };
  const routed = createRoutedProvider(config, "deepseek");
  assert.equal(routed.degraded, true, "no claude key -> degraded");
  assert.match(routed.label, /no key for claude/);
}

// 11. createRoutedProvider builds a working router when both tiers have keys.
{
  const config: ScissorConfig = {
    defaultProvider: "deepseek",
    providers: { deepseek: { apiKey: "x" } },
    router: { enabled: true, strong: { model: "deepseek-reasoner" } },
  };
  const routed = createRoutedProvider(config, "deepseek");
  assert.equal(routed.degraded, false);
  assert.ok(routed.provider instanceof RouterProvider);
  assert.match(routed.label, /deepseek-chat \| deepseek:deepseek-reasoner/);
}

process.stdout.write("test-router: ALL PASS\n");
