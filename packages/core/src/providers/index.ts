import {
  PROVIDER_DEFAULTS,
  resolveBaseURL,
  resolveModel,
  type ScissorConfig,
} from "../config.js";
import type { LLMProvider, ProviderId } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

export { AnthropicProvider } from "./anthropic.js";
export { OpenAICompatibleProvider } from "./openai-compatible.js";

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
): LLMProvider {
  const providerConfig = config.providers[id];
  const apiKey = providerConfig?.apiKey?.trim();
  if (!apiKey) throw new MissingApiKeyError(id);

  const model = resolveModel(config, id);
  const baseURL = resolveBaseURL(config, id);
  const kind = PROVIDER_DEFAULTS[id].kind;

  if (kind === "anthropic") {
    return new AnthropicProvider({ apiKey, model, baseURL });
  }
  return new OpenAICompatibleProvider({ id, apiKey, model, baseURL });
}
