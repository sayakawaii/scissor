/**
 * Deterministic test: proxy-aware provider transport (providers/proxy.ts).
 *
 * The provider SDKs ignore *_PROXY env vars, so behind a proxy/SSH tunnel scissor
 * must hand them Node's global fetch (which honors NODE_USE_ENV_PROXY). This
 * verifies proxyFetch() opts in ONLY when NODE_USE_ENV_PROXY is set, so normal
 * direct runs keep the SDK default untouched.
 *
 * Run: node --import tsx scripts/test-proxy.mts
 */
import assert from "node:assert/strict";
import { proxyFetch } from "../packages/core/src/providers/proxy.js";

const saved = process.env.NODE_USE_ENV_PROXY;
try {
  delete process.env.NODE_USE_ENV_PROXY;
  assert.equal(proxyFetch(), undefined, "no NODE_USE_ENV_PROXY -> undefined (SDK default)");

  process.env.NODE_USE_ENV_PROXY = "1";
  assert.equal(proxyFetch(), globalThis.fetch, "NODE_USE_ENV_PROXY=1 -> global fetch (honors HTTPS_PROXY)");

  // Any truthy value opts in (Node reads the switch, not a specific value).
  process.env.NODE_USE_ENV_PROXY = "true";
  assert.equal(proxyFetch(), globalThis.fetch, "any truthy value opts in");

  process.env.NODE_USE_ENV_PROXY = "";
  assert.equal(proxyFetch(), undefined, "empty string is falsy -> undefined");
} finally {
  if (saved === undefined) delete process.env.NODE_USE_ENV_PROXY;
  else process.env.NODE_USE_ENV_PROXY = saved;
}

process.stdout.write("test-proxy: ALL PASS\n");
