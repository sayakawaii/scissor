/**
 * Deterministic test for the `web_search` tool (Tavily).
 *
 * Local retrieval can only answer what the workspace contains, so `web_search`
 * is the agent's one path to information that lives outside it. That makes the
 * request contract worth pinning: these assertions check the exact HTTP call the
 * tool issues (endpoint, bearer auth, body), how a response is turned into the
 * agent-facing result, and — just as important — that every failure is reported
 * as a clean dead end instead of an exception: no key, no network policy, HTTP
 * 401/429, and malformed JSON.
 *
 * No network: the fetch layer is injected via ToolContext.webSearch.fetchImpl,
 * and a stub that is never allowed to run guards the paths that must short-
 * circuit before any request.
 *
 * Run: node --import tsx scripts/test-tavily.mts
 */
import assert from "node:assert/strict";
import {
  buildSystemPrompt,
  chatTools,
  createSandboxPolicy,
  defaultTools,
  formatTavilyResponse,
  TAVILY_SEARCH_ENDPOINT,
  webSearchTool,
  type ToolContext,
  type WebSearchConfig,
} from "@scissor/core";

const WORKSPACE = process.cwd();

interface Capture {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Record every request and reply with a canned response. */
function stubFetch(reply: () => Response): {
  fetchImpl: typeof globalThis.fetch;
  calls: Capture[];
} {
  const calls: Capture[] = [];
  const fetchImpl: typeof globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return reply();
  };
  return { fetchImpl, calls };
}

/** A fetch that fails the test if it is ever called. */
const forbiddenFetch: typeof globalThis.fetch = async () => {
  throw new Error("web_search issued a request when it must not have");
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ctx(webSearch: WebSearchConfig, extra: Partial<ToolContext> = {}): ToolContext {
  return { workspaceRoot: WORKSPACE, webSearch, ...extra };
}

const SAMPLE = {
  query: "vitest projects config",
  answer: "Vitest 3 replaces workspace files with the `projects` option.",
  results: [
    {
      title: "Vitest | Projects",
      url: "https://vitest.dev/guide/projects",
      content: "Use   the\n`projects`\t option   in vitest.config.ts.",
      score: 0.98,
      published_date: "Tue, 11 Mar 2025 17:00:00 GMT",
    },
    { title: "   ", url: "https://example.com/b", content: "A second source." },
  ],
  response_time: 1.2,
};

// The env var is a real input to the tool, so pin it for the whole run.
const savedEnvKey = process.env.TAVILY_API_KEY;
delete process.env.TAVILY_API_KEY;

try {
  // --- 1. Registration and read-only-ness -----------------------------------
  // Read-only tools parallelize and skip approval; a web lookup must qualify.
  assert.equal(webSearchTool.name, "web_search");
  assert.equal(webSearchTool.mutating, false, "web_search must be marked read-only");
  assert.ok(
    defaultTools().some((t) => t.name === "web_search"),
    "web_search must be in the default tool set",
  );
  assert.ok(
    chatTools().some((t) => t.name === "web_search"),
    "web_search must be available in chat-only mode (it mutates nothing)",
  );
  assert.deepEqual(webSearchTool.parameters.required, ["query"]);

  // --- 2. The request contract ----------------------------------------------
  {
    const { fetchImpl, calls } = stubFetch(() => json(SAMPLE));
    const res = await webSearchTool.run(
      { query: "  vitest projects config  " },
      ctx({ apiKey: "test-key", fetchImpl }),
    );
    assert.ok(!res.isError, "a 200 response must not be reported as an error");
    assert.equal(calls.length, 1, "exactly one request per call");

    const call = calls[0]!;
    assert.equal(call.url, TAVILY_SEARCH_ENDPOINT);
    assert.equal(call.method, "POST");
    assert.equal(
      call.headers.authorization,
      "Bearer test-key",
      "the key must travel as a bearer token, not in the body",
    );
    assert.match(String(call.headers["content-type"]), /application\/json/);
    assert.equal(call.body.query, "vitest projects config", "query must be trimmed");
    assert.equal(call.body.max_results, 5, "default max_results");
    assert.equal(call.body.search_depth, "basic", "default search_depth");
    assert.equal(call.body.include_answer, true);
  }

  // --- 3. Argument coercion (models send "3" for 3, and mixed case enums) ----
  {
    const { fetchImpl, calls } = stubFetch(() => json(SAMPLE));
    const c = ctx({ apiKey: "k", fetchImpl });

    await webSearchTool.run({ query: "q", max_results: "3", search_depth: "ADVANCED" }, c);
    assert.equal(calls[0]!.body.max_results, 3, "numeric string must coerce to a number");
    assert.equal(calls[0]!.body.search_depth, "advanced", "enum must coerce case-insensitively");

    await webSearchTool.run({ query: "q", max_results: 99 }, c);
    assert.equal(calls[1]!.body.max_results, 10, "max_results is clamped to the API maximum");

    await webSearchTool.run({ query: "q", max_results: 2.7 }, c);
    assert.equal(calls[2]!.body.max_results, 2, "fractional max_results is floored");

    await webSearchTool.run({ query: "q", max_results: "not a number" }, c);
    assert.equal(calls[3]!.body.max_results, 5, "unreadable max_results falls back to the default");
  }

  // Ambiguous input is refused rather than guessed at, and refusal costs no request.
  {
    const empty = await webSearchTool.run({ query: "   " }, ctx({ apiKey: "k", fetchImpl: forbiddenFetch }));
    assert.ok(empty.isError && /'query' is required/.test(empty.content));

    const badDepth = await webSearchTool.run(
      { query: "q", search_depth: "deep" },
      ctx({ apiKey: "k", fetchImpl: forbiddenFetch }),
    );
    assert.ok(badDepth.isError, "an unrecognized search_depth must be refused");
    assert.match(badDepth.content, /search_depth/);
  }

  // --- 4. Response parsing ---------------------------------------------------
  {
    const { fetchImpl } = stubFetch(() => json(SAMPLE));
    const res = await webSearchTool.run({ query: "vitest projects config" }, ctx({ apiKey: "k", fetchImpl }));
    assert.ok(!res.isError);
    assert.match(res.content, /vitest projects config/);
    assert.match(res.content, /Summary: Vitest 3 replaces workspace files/);
    assert.match(res.content, /1\. Vitest \| Projects \(Tue, 11 Mar 2025 17:00:00 GMT\)/);
    assert.match(res.content, /https:\/\/vitest\.dev\/guide\/projects/);
    assert.match(
      res.content,
      /Use the `projects` option in vitest\.config\.ts\./,
      "whitespace in snippets must be collapsed",
    );
    assert.match(res.content, /2\. \(untitled\)/, "a blank title must not produce an empty line");
    assert.match(res.content, /https:\/\/example\.com\/b/);
  }

  // Empty and malformed payloads still produce usable guidance, never a throw.
  {
    const { fetchImpl } = stubFetch(() => json({ query: "x", results: [] }));
    const res = await webSearchTool.run({ query: "x" }, ctx({ apiKey: "k", fetchImpl }));
    assert.ok(!res.isError, "zero results is an answer, not an error");
    assert.match(res.content, /No results/);

    const long = "word ".repeat(400);
    const formatted = formatTavilyResponse({ results: [{ title: "T", url: "u", content: long }] }, "q");
    assert.ok(formatted.includes("…"), "long snippets must be clipped");
    assert.ok(formatted.length < long.length, "clipping must actually shrink the output");

    assert.doesNotThrow(() => formatTavilyResponse({ results: "not an array" }, "q"));
    assert.doesNotThrow(() => formatTavilyResponse({ results: [{}] }, "q"));
  }

  // --- 5. Missing key: a clear dead end, not a throw or a hang ---------------
  {
    const res = await webSearchTool.run({ query: "q" }, ctx({ fetchImpl: forbiddenFetch }));
    assert.ok(res.isError, "a missing key must be reported as an error result");
    assert.match(res.content, /no Tavily API key/);
    assert.match(res.content, /TAVILY_API_KEY/, "the message must say how to fix it");
    assert.match(res.content, /do not retry/i, "the agent must be told this is a dead end");
  }

  // The env var is the fallback when nothing was configured.
  {
    process.env.TAVILY_API_KEY = "env-key";
    try {
      const { fetchImpl, calls } = stubFetch(() => json(SAMPLE));
      const res = await webSearchTool.run({ query: "q" }, ctx({ fetchImpl }));
      assert.ok(!res.isError);
      assert.equal(calls[0]!.headers.authorization, "Bearer env-key");
    } finally {
      delete process.env.TAVILY_API_KEY;
    }
  }

  // Configured key wins over the environment.
  {
    process.env.TAVILY_API_KEY = "env-key";
    try {
      const { fetchImpl, calls } = stubFetch(() => json(SAMPLE));
      await webSearchTool.run({ query: "q" }, ctx({ apiKey: "config-key", fetchImpl }));
      assert.equal(calls[0]!.headers.authorization, "Bearer config-key");
    } finally {
      delete process.env.TAVILY_API_KEY;
    }
  }

  // --- 6. Network egress obeys the sandbox, failing closed ------------------
  {
    const policy = createSandboxPolicy(WORKSPACE, { network: "none" });
    const res = await webSearchTool.run(
      { query: "q" },
      ctx({ apiKey: "k", fetchImpl: forbiddenFetch }, { sandbox: policy }),
    );
    assert.ok(res.isError, "a no-network policy must block the request");
    assert.match(res.content, /sandbox network policy/);
  }

  // --- 7. HTTP errors become actionable dead ends ---------------------------
  {
    const unauthorized = await webSearchTool.run(
      { query: "q" },
      ctx({ apiKey: "bad", fetchImpl: stubFetch(() => json({ detail: "invalid key" }, 401)).fetchImpl }),
    );
    assert.ok(unauthorized.isError);
    assert.match(unauthorized.content, /rejected the API key \(HTTP 401\)/);
    assert.match(unauthorized.content, /invalid key/, "the server's explanation must be passed along");

    const limited = await webSearchTool.run(
      { query: "q" },
      ctx({ apiKey: "k", fetchImpl: stubFetch(() => json({}, 429)).fetchImpl }),
    );
    assert.ok(limited.isError);
    assert.match(limited.content, /rate limit/i);
    assert.match(limited.content, /do not retry immediately/i);

    const serverError = await webSearchTool.run(
      { query: "q" },
      ctx({ apiKey: "k", fetchImpl: stubFetch(() => json({}, 503)).fetchImpl }),
    );
    assert.ok(serverError.isError);
    assert.match(serverError.content, /HTTP 503/);

    // A huge error body must not flood the agent's context.
    const flood = await webSearchTool.run(
      { query: "q" },
      ctx({
        apiKey: "k",
        fetchImpl: stubFetch(() => new Response("x".repeat(50_000), { status: 500 })).fetchImpl,
      }),
    );
    assert.ok(flood.isError);
    assert.ok(flood.content.length < 500, "an oversized error body must be clipped");
  }

  // Non-JSON success bodies and transport failures are caught, not propagated.
  {
    const notJson = await webSearchTool.run(
      { query: "q" },
      ctx({ apiKey: "k", fetchImpl: stubFetch(() => new Response("<html>nope</html>", { status: 200 })).fetchImpl }),
    );
    assert.ok(notJson.isError);
    assert.match(notJson.content, /not valid JSON/);

    const offline: typeof globalThis.fetch = async () => {
      throw new Error("getaddrinfo ENOTFOUND api.tavily.com");
    };
    const down = await webSearchTool.run({ query: "q" }, ctx({ apiKey: "k", fetchImpl: offline }));
    assert.ok(down.isError);
    assert.match(down.content, /ENOTFOUND/);
  }

  // --- 8. Cancellation is honored -------------------------------------------
  {
    const controller = new AbortController();
    controller.abort();
    const res = await webSearchTool.run(
      { query: "q" },
      ctx(
        {
          apiKey: "k",
          fetchImpl: async (_url, init) => {
            init?.signal?.throwIfAborted();
            return json(SAMPLE);
          },
        },
        { signal: controller.signal },
      ),
    );
    assert.ok(res.isError, "an already-aborted signal must abort the request");
    assert.match(res.content, /cancelled/);
  }

  // --- 9. A custom endpoint is honored (self-hosted / proxied gateways) -----
  {
    const { fetchImpl, calls } = stubFetch(() => json(SAMPLE));
    await webSearchTool.run(
      { query: "q" },
      ctx({ apiKey: "k", fetchImpl, endpoint: "https://gateway.internal/search" }),
    );
    assert.equal(calls[0]!.url, "https://gateway.internal/search");
  }

  // --- 10. The prompt teaches the agent when to reach for it ----------------
  // A tool the model never thinks to call is dead weight, and the guidance must
  // not appear in sessions where the tool was not handed over.
  {
    const base = { workspaceRoot: WORKSPACE, platform: "linux", approvalPolicy: "auto" } as const;
    const withTool = buildSystemPrompt({ ...base, tools: defaultTools() });
    assert.match(withTool, /- web_search: Search the public web/, "inventory must list web_search");
    assert.match(withTool, /call web_search rather than guessing/, "principles must point at it");

    const withoutTool = buildSystemPrompt({ ...base, tools: [] });
    assert.ok(
      !withoutTool.includes("web_search"),
      "no web_search guidance when the tool is not in the session's tool set",
    );
  }
} finally {
  if (savedEnvKey === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = savedEnvKey;
}

process.stdout.write("test-tavily: ALL PASS\n");
