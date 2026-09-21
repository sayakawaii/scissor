/**
 * Deterministic test for the Nebius Token Factory provider (NVIDIA Nemotron).
 *
 * Token Factory speaks the OpenAI wire format, so the whole integration is a
 * config entry — no new adapter. These assertions pin that claim down: the
 * provider resolves through `OpenAICompatibleProvider`, the two Nemotron tiers
 * are distinct (so the router is a real cheap/strong split rather than a no-op),
 * and the regional base URL stays overridable.
 *
 * No network: nothing here issues a request.
 *
 * Run: node --import tsx scripts/test-nebius.mts
 */
import assert from "node:assert/strict";
import {
  applyEnvOverrides,
  createProvider,
  MissingApiKeyError,
  OpenAICompatibleProvider,
  PREMIUM_MODELS,
  PROVIDER_DEFAULTS,
  PROVIDER_IDS,
  resolveBaseURL,
  resolveModel,
  resolveRouterTiers,
  routerWouldHelp,
  type ScissorConfig,
} from "@scissor/core";

const keyed: ScissorConfig = {
  defaultProvider: "nebius",
  providers: { nebius: { apiKey: "test-key" } },
};

// --- registered as a first-class provider ---
{
  assert.ok(PROVIDER_IDS.includes("nebius"), "nebius is a selectable provider");
  const d = PROVIDER_DEFAULTS.nebius;
  assert.equal(d.kind, "openai", "Token Factory is OpenAI-compatible (no bespoke adapter)");
  assert.equal(d.baseURL, "https://api.tokenfactory.nebius.com/v1", "Token Factory endpoint");
  assert.match(d.model, /^nvidia\//, "default model is an NVIDIA open model");
  assert.match(d.model, /Nemotron/i, "default model is from the Nemotron family");
}

// --- two distinct tiers, so routing actually does something ---
{
  const cheap = PROVIDER_DEFAULTS.nebius.model;
  const strong = PREMIUM_MODELS.nebius;
  assert.match(strong, /^nvidia\//, "strong tier is also an NVIDIA open model");
  assert.notEqual(strong, cheap, "strong tier differs from the cheap tier");

  const tiers = resolveRouterTiers(keyed, "nebius");
  assert.deepEqual(tiers.cheap, { provider: "nebius", model: cheap }, "cheap tier = Nemotron Nano");
  assert.deepEqual(tiers.strong, { provider: "nebius", model: strong }, "strong tier = Nemotron Super");
  assert.equal(routerWouldHelp(keyed, "nebius"), true, "routing is a real win for nebius");
}

// --- resolves through the shared OpenAI-compatible transport ---
{
  const provider = createProvider(keyed, "nebius");
  assert.ok(
    provider instanceof OpenAICompatibleProvider,
    "nebius reuses OpenAICompatibleProvider — the integration adds no adapter",
  );
  assert.equal(provider.id, "nebius");
  assert.equal(provider.model, PROVIDER_DEFAULTS.nebius.model, "uses the Nemotron default model");

  const override = createProvider(keyed, "nebius", "nvidia/Nemotron-3-Ultra-550b-a55b");
  assert.equal(override.model, "nvidia/Nemotron-3-Ultra-550b-a55b", "per-session model override wins");
}

// --- missing key fails closed, rather than silently going keyless ---
{
  const bare: ScissorConfig = { defaultProvider: "nebius", providers: {} };
  assert.throws(
    () => createProvider(bare, "nebius"),
    (err: unknown) => err instanceof MissingApiKeyError && err.providerId === "nebius",
    "no key -> MissingApiKeyError naming nebius",
  );
}

// --- config overrides: regional endpoint + pinned model ---
{
  const regional: ScissorConfig = {
    defaultProvider: "nebius",
    providers: {
      nebius: {
        apiKey: "test-key",
        baseURL: "https://api.tokenfactory.us-central1.nebius.com/v1",
        model: "nvidia/nemotron-3-super-120b-a12b",
      },
    },
  };
  assert.equal(
    resolveBaseURL(regional, "nebius"),
    "https://api.tokenfactory.us-central1.nebius.com/v1",
    "regional base URL overrides the global endpoint",
  );
  assert.equal(resolveModel(regional, "nebius"), "nvidia/nemotron-3-super-120b-a12b");
  assert.equal(
    resolveBaseURL(keyed, "nebius"),
    PROVIDER_DEFAULTS.nebius.baseURL,
    "falls back to the global endpoint when unset",
  );
}

// --- NEBIUS_API_KEY is picked up from the environment ---
{
  const had = Object.prototype.hasOwnProperty.call(process.env, "NEBIUS_API_KEY");
  const prev = process.env.NEBIUS_API_KEY;
  process.env.NEBIUS_API_KEY = "env-key";
  try {
    const merged = applyEnvOverrides({ defaultProvider: "nebius", providers: {} });
    assert.equal(merged.providers.nebius?.apiKey, "env-key", "NEBIUS_API_KEY populates the provider");
  } finally {
    if (had) process.env.NEBIUS_API_KEY = prev;
    else delete process.env.NEBIUS_API_KEY;
  }
}

process.stdout.write("test-nebius: ALL PASS\n");
