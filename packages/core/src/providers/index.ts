import {
  PROVIDER_DEFAULTS,
  resolveBaseURL,
  resolveModel,
  resolveRouterTiers,
  type ScissorConfig,
} from "../config.js";
import type { LLMProvider, ProviderId } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import {
  RouterProvider,
  type RouteDecision,
  type RouterTier,
} from "./router.js";

export { AnthropicProvider } from "./anthropic.js";
export { OpenAICompatibleProvider } from "./openai-compatible.js";
export { safeParseJsonObject } from "./util.js";
export {
  RouterProvider,
  routeTurn,
  HARD_KEYWORDS,
  ROUTE_WEIGHTS,
  DEFAULT_ROUTE_THRESHOLD,
} from "./router.js";
export type {
  RouteDecision,
  RouteInput,
  RouteTier,
  RouterTier,
  RouterProviderOptions,
} from "./router.js";

export class MissingApiKeyError extends Error {
  constructor(public providerId: ProviderId) {
    super(
      `No API key configured for "${providerId}". Run \`scissor config\` to add one.`,
    );
    this.name = "MissingApiKeyError";
  }
}

/**
 * Build a provider instance from config. Throws MissingApiKeyError when the
 * selected provider has no key.
 */
export function createProvider(
  config: ScissorConfig,
  id: ProviderId,
  modelOverride?: string,
): LLMProvider {
  const providerConfig = config.providers[id];
  const apiKey = providerConfig?.apiKey?.trim();
  if (!apiKey) throw new MissingApiKeyError(id);

  const model = modelOverride?.trim() || resolveModel(config, id);
  const baseURL = resolveBaseURL(config, id);
  const kind = PROVIDER_DEFAULTS[id].kind;

  if (kind === "anthropic") {
    return new AnthropicProvider({ apiKey, model, baseURL });
  }
  return new OpenAICompatibleProvider({ id, apiKey, model, baseURL });
}

export interface RoutedProvider {
  provider: LLMProvider;
  /** Display label, e.g. "router(deepseek:deepseek-chat | deepseek:deepseek-reasoner)". */
  label: string;
  /** True when the strong tier fell back to the cheap tier (no key). */
  degraded: boolean;
}

export interface CreateRoutedProviderOptions {
  onRoute?: (decision: RouteDecision & { tierLabel: string; model: string }) => void;
}

/**
 * Build a RouterProvider from config, using `baseProvider` as the default tier
 * provider. The cheap tier must have a usable key (it is the base provider). If
 * the strong tier lacks a key, it gracefully degrades to the cheap tier so
 * routing becomes a no-op rather than failing the session.
 */
export function createRoutedProvider(
  config: ScissorConfig,
  baseProvider: ProviderId,
  opts: CreateRoutedProviderOptions = {},
): RoutedProvider {
  const tiers = resolveRouterTiers(config, baseProvider);
  const cheapLabel = `${tiers.cheap.provider}:${tiers.cheap.model}`;
  const cheapProvider = createProvider(config, tiers.cheap.provider, tiers.cheap.model);
  const cheap: RouterTier = { provider: cheapProvider, label: cheapLabel };

  let degraded = false;
  let strong: RouterTier;
  const strongLabel = `${tiers.strong.provider}:${tiers.strong.model}`;
  try {
    const strongProvider = createProvider(config, tiers.strong.provider, tiers.strong.model);
    strong = { provider: strongProvider, label: strongLabel };
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      degraded = true;
      strong = { provider: cheapProvider, label: `${cheapLabel} (no key for ${tiers.strong.provider})` };
    } else {
      throw err;
    }
  }

  const provider = new RouterProvider({
    cheap,
    strong,
    threshold: tiers.threshold,
    escalateOnVerifyFail: tiers.escalateOnVerifyFail,
    onRoute: opts.onRoute,
  });
  return { provider, label: provider.model, degraded };
}
