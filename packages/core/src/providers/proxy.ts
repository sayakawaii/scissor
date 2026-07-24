/**
 * Proxy-aware transport selection for provider SDKs.
 *
 * The OpenAI / Anthropic SDKs ship their own HTTP transport that ignores the
 * standard proxy environment variables, so behind a corporate proxy or an SSH
 * tunnel their requests go direct and time out. Node's built-in global `fetch`
 * (Node ≥ 24) DOES honor proxies when started with `NODE_USE_ENV_PROXY=1`
 * (reading `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`). So when that switch is set we
 * hand the SDK the global fetch; otherwise we return undefined and leave the SDK
 * default untouched (zero behavior change for normal, direct runs).
 *
 * See docs/benchmarking.md → "Reaching DeepSeek through a VPS".
 */
export function proxyFetch(): typeof globalThis.fetch | undefined {
  return process.env.NODE_USE_ENV_PROXY && typeof globalThis.fetch === "function"
    ? globalThis.fetch
    : undefined;
}
