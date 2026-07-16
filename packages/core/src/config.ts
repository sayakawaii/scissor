import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderId } from "./types.js";

export interface ProviderConfig {
  apiKey?: string;
  model?: string;
  /** Override base URL (mainly for OpenAI-compatible providers). */
  baseURL?: string;
}

/** One tier (cheap/strong) of the heuristic model router. */
export interface RouterTierConfig {
  /** Provider to use for this tier (defaults to the session's base provider). */
  provider?: ProviderId;
  /** Model override for this tier (defaults per provider, see PREMIUM_MODELS). */
  model?: string;
}

/** Persistent config for the heuristic model router. */
export interface RouterConfig {
  /** Turn routing on by default (also toggled per-session with --router). */
  enabled?: boolean;
  cheap?: RouterTierConfig;
  strong?: RouterTierConfig;
  /** Score at/above which a turn escalates to the strong tier (default 3). */
  threshold?: number;
  /** Escalate to strong after a failed verification (default true). */
  escalateOnVerifyFail?: boolean;
}

export interface ScissorConfig {
  defaultProvider: ProviderId;
  providers: Partial<Record<ProviderId, ProviderConfig>>;
  /** Default test-first (TDD) enforcement when not overridden by a CLI flag. */
  tddMode?: boolean;
  /**
   * Lead ambiguous requests with a clarifying question (2-3 concrete options)
   * before planning. Off unless enabled; overridden per-session by --clarify.
   */
  clarifyIntent?: boolean;
  /** Heuristic model router (cheap/strong tiers). Off unless enabled. */
  router?: RouterConfig;
}

/** Built-in defaults per provider: default model and base URL. */
export const PROVIDER_DEFAULTS: Record<
  ProviderId,
  { label: string; model: string; baseURL?: string; kind: "openai" | "anthropic" }
> = {
  deepseek: {
    label: "DeepSeek",
    model: "deepseek-chat",
    baseURL: "https://api.deepseek.com",
    kind: "openai",
  },
  claude: {
    label: "Claude (Anthropic)",
    model: "claude-sonnet-4-20250514",
    kind: "anthropic",
  },
  gpt: {
    label: "OpenAI GPT",
    model: "gpt-4o",
    baseURL: "https://api.openai.com/v1",
    kind: "openai",
  },
  glm: {
    label: "GLM (Zhipu)",
    model: "glm-4-plus",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    kind: "openai",
  },
};

export const PROVIDER_IDS: ProviderId[] = ["deepseek", "claude", "gpt", "glm"];

/**
 * Default "strong" tier model per provider, used by the router when the strong
 * tier's model is not explicitly configured. Falls back to the provider default
 * for providers whose default model is already the capable one.
 */
export const PREMIUM_MODELS: Record<ProviderId, string> = {
  deepseek: "deepseek-reasoner",
  claude: "claude-sonnet-4-20250514",
  gpt: "gpt-4o",
  glm: "glm-4-plus",
};

const DEFAULT_CONFIG: ScissorConfig = {
  defaultProvider: "deepseek",
  providers: {},
};

/** Directory where scissor stores its config: ~/.scissor */
export function getConfigDir(): string {
  const override = process.env.SCISSOR_CONFIG_DIR;
  if (override && override.trim().length > 0) return path.resolve(override);
  return path.join(os.homedir(), ".scissor");
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), "config.json");
}

export async function loadConfig(): Promise<ScissorConfig> {
  const file = getConfigPath();
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<ScissorConfig>;
    return normalizeConfig(parsed);
  } catch (err: unknown) {
    if (isNotFound(err)) return { ...DEFAULT_CONFIG, providers: {} };
    throw new Error(
      `Failed to read config at ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function saveConfig(config: ScissorConfig): Promise<void> {
  const dir = getConfigDir();
  await fs.mkdir(dir, { recursive: true });
  const file = getConfigPath();
  await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  // Best-effort tighten permissions (no-op semantics on Windows).
  try {
    await fs.chmod(file, 0o600);
  } catch {
    /* ignore */
  }
}

/** Merge env-var overrides on top of stored config (env wins). */
export function applyEnvOverrides(config: ScissorConfig): ScissorConfig {
  const merged: ScissorConfig = {
    ...config,
    providers: { ...config.providers },
  };
  const envMap: Record<ProviderId, string> = {
    deepseek: "DEEPSEEK_API_KEY",
    claude: "ANTHROPIC_API_KEY",
    gpt: "OPENAI_API_KEY",
    glm: "GLM_API_KEY",
  };
  for (const id of PROVIDER_IDS) {
    const envKey = process.env[envMap[id]];
    if (envKey && envKey.trim().length > 0) {
      merged.providers[id] = { ...merged.providers[id], apiKey: envKey.trim() };
    }
  }
  const envDefault = process.env.SCISSOR_PROVIDER as ProviderId | undefined;
  if (envDefault && PROVIDER_IDS.includes(envDefault)) {
    merged.defaultProvider = envDefault;
  }
  return merged;
}

/** Resolve the effective model for a provider (config override or default). */
export function resolveModel(config: ScissorConfig, id: ProviderId): string {
  return config.providers[id]?.model?.trim() || PROVIDER_DEFAULTS[id].model;
}

/** Resolve the effective base URL for a provider. */
export function resolveBaseURL(config: ScissorConfig, id: ProviderId): string | undefined {
  return config.providers[id]?.baseURL?.trim() || PROVIDER_DEFAULTS[id].baseURL;
}

export interface ResolvedRouterTiers {
  cheap: { provider: ProviderId; model: string };
  strong: { provider: ProviderId; model: string };
  threshold: number;
  escalateOnVerifyFail: boolean;
}

/**
 * Resolve concrete router tiers from config, using `baseProvider` as the default
 * for both tiers. The cheap tier defaults to the base provider's default model;
 * the strong tier defaults to that provider's PREMIUM_MODELS entry.
 */
export function resolveRouterTiers(
  config: ScissorConfig,
  baseProvider: ProviderId,
): ResolvedRouterTiers {
  const r = config.router ?? {};
  const cheapProvider = r.cheap?.provider ?? baseProvider;
  const cheapModel = r.cheap?.model?.trim() || resolveModel(config, cheapProvider);
  const strongProvider = r.strong?.provider ?? cheapProvider;
  const strongModel =
    r.strong?.model?.trim() || PREMIUM_MODELS[strongProvider] || resolveModel(config, strongProvider);
  return {
    cheap: { provider: cheapProvider, model: cheapModel },
    strong: { provider: strongProvider, model: strongModel },
    threshold: typeof r.threshold === "number" ? r.threshold : 3,
    escalateOnVerifyFail: r.escalateOnVerifyFail ?? true,
  };
}

function normalizeConfig(parsed: Partial<ScissorConfig>): ScissorConfig {
  const defaultProvider =
    parsed.defaultProvider && PROVIDER_IDS.includes(parsed.defaultProvider)
      ? parsed.defaultProvider
      : DEFAULT_CONFIG.defaultProvider;
  return {
    defaultProvider,
    providers: parsed.providers ?? {},
    tddMode: parsed.tddMode === true ? true : undefined,
    clarifyIntent: parsed.clarifyIntent === true ? true : undefined,
    router: parsed.router,
  };
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
