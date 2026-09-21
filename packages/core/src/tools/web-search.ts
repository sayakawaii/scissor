/**
 * Web search via the Tavily API.
 *
 * `retrieve`/`grep`/`glob` can only answer questions the workspace already
 * contains. The moment the agent meets an unfamiliar library, a third-party API
 * it has to call correctly, or an error string produced by code that isn't
 * checked in, local retrieval is a dead end and the model's only remaining move
 * is to guess. This tool is the escape hatch: one read-only network lookup that
 * returns ranked, already-summarized page content.
 *
 * Tavily is called over plain HTTP with `fetch` rather than through its SDK.
 * That keeps the dependency count flat and, per providers/proxy.ts, is the
 * proxy-friendly choice — the global fetch honors `HTTPS_PROXY`, SDK transports
 * generally do not.
 */
import type { Tool, ToolContext, WebSearchConfig } from "../types.js";
import { coerceEnum, coerceNumber } from "./coerce.js";

export const TAVILY_SEARCH_ENDPOINT = "https://api.tavily.com/search";

const DEFAULT_MAX_RESULTS = 5;
const MAX_MAX_RESULTS = 10;
/** Snippet budget per result: enough to judge relevance, small enough to keep many. */
const MAX_SNIPPET_CHARS = 600;
const REQUEST_TIMEOUT_MS = 20_000;
/** Cap on an error body echoed back to the agent, so a HTML error page can't flood context. */
const MAX_ERROR_BODY_CHARS = 200;

const SEARCH_DEPTHS = ["basic", "advanced"] as const;
type SearchDepth = (typeof SEARCH_DEPTHS)[number];

/** One entry of the Tavily `results` array (only the fields we render). */
export interface TavilySearchResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  score?: unknown;
  published_date?: unknown;
}

/** The Tavily `POST /search` response body (only the fields we render). */
export interface TavilySearchResponse {
  query?: unknown;
  answer?: unknown;
  results?: unknown;
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Render a Tavily response as the agent-facing result. Kept separate from the
 * request so the parsing rules are directly testable, and defensive about every
 * field: a search result with a missing title or content is still worth showing.
 */
export function formatTavilyResponse(data: TavilySearchResponse, query: string): string {
  const results = Array.isArray(data.results) ? (data.results as TavilySearchResult[]) : [];
  const lines: string[] = [`Web search results for: ${query}`];

  const answer = typeof data.answer === "string" ? data.answer.trim() : "";
  if (answer) lines.push("", `Summary: ${clip(answer, 1000)}`);

  if (results.length === 0) {
    lines.push("", "No results. Try different or more specific search terms.");
    return lines.join("\n");
  }

  lines.push("");
  results.forEach((r, i) => {
    const title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : "(untitled)";
    const url = typeof r.url === "string" ? r.url.trim() : "";
    const published =
      typeof r.published_date === "string" && r.published_date.trim()
        ? ` (${r.published_date.trim()})`
        : "";
    lines.push(`${i + 1}. ${title}${published}`);
    if (url) lines.push(`   ${url}`);
    const content = typeof r.content === "string" ? clip(r.content, MAX_SNIPPET_CHARS) : "";
    if (content) lines.push(`   ${content}`);
  });

  lines.push(
    "",
    "Snippets are extracts, not full pages. Open a URL (or fetch it) before relying on exact API details.",
  );
  return lines.join("\n");
}

/** Resolve the key from the injected config, falling back to the environment. */
function resolveApiKey(cfg: WebSearchConfig | undefined): string | undefined {
  const fromConfig = cfg?.apiKey?.trim();
  if (fromConfig) return fromConfig;
  const fromEnv = process.env.TAVILY_API_KEY?.trim();
  return fromEnv || undefined;
}

/**
 * Bound the request in time and honor cancellation, without depending on
 * `AbortSignal.any` (Node 20+ only).
 */
function linkAbort(signal: AbortSignal | undefined): { controller: AbortController; done(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    controller,
    done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** Turn a non-2xx Tavily response into a dead end the agent can act on. */
function describeHttpError(status: number, body: string): string {
  const detail = body.trim() ? ` Response: ${clip(body, MAX_ERROR_BODY_CHARS)}` : "";
  if (status === 401 || status === 403) {
    return (
      `Error: Tavily rejected the API key (HTTP ${status}). ` +
      `Check the key set via \`scissor config\` or TAVILY_API_KEY.${detail}`
    );
  }
  if (status === 429) {
    return (
      `Error: Tavily rate limit / quota exceeded (HTTP 429). ` +
      `Do not retry immediately — continue without web search.${detail}`
    );
  }
  if (status === 400) {
    return `Error: Tavily rejected the request (HTTP 400). Try a simpler query.${detail}`;
  }
  return `Error: Tavily request failed with HTTP ${status}.${detail}`;
}

export const webSearchTool: Tool = {
  name: "web_search",
  description:
    "Search the public web (Tavily) and return ranked results with summarized page content. " +
    "Use this when the workspace cannot answer the question: an unfamiliar library or framework, " +
    "the current signature/behavior of a third-party API, an error message coming from a dependency, " +
    "release notes, or anything that may have changed since training. " +
    "Prefer `retrieve`/`grep` first for anything that lives in this repository.",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Natural-language search query. Be specific and include version/library names, " +
          "e.g. 'vitest 3 workspace config projects option'.",
      },
      max_results: {
        type: "number",
        description: `Number of results to return, 1-${MAX_MAX_RESULTS} (default ${DEFAULT_MAX_RESULTS}).`,
      },
      search_depth: {
        type: "string",
        enum: [...SEARCH_DEPTHS],
        description:
          "'basic' (default, fast) or 'advanced' (slower, better for obscure or technical queries).",
      },
    },
    required: ["query"],
  },
  async run(args: Record<string, unknown>, ctx: ToolContext) {
    const query = String(args.query ?? "").trim();
    if (!query) return { content: "Error: 'query' is required.", isError: true };

    const requested = coerceNumber(args.max_results);
    const maxResults =
      requested !== undefined && requested >= 1
        ? Math.min(Math.floor(requested), MAX_MAX_RESULTS)
        : DEFAULT_MAX_RESULTS;

    let searchDepth: SearchDepth = "basic";
    if (args.search_depth !== undefined && args.search_depth !== null) {
      const coerced = coerceEnum(args.search_depth, SEARCH_DEPTHS);
      if (!coerced) {
        return {
          content: `Error: 'search_depth' must be one of ${SEARCH_DEPTHS.join(", ")}.`,
          isError: true,
        };
      }
      searchDepth = coerced;
    }

    // Network egress is a sandbox concern: refuse rather than quietly reaching out.
    if (ctx.sandbox?.network === "none") {
      return {
        content:
          "Error: web_search is unavailable because the sandbox network policy is 'none'. " +
          "Continue without web search.",
        isError: true,
      };
    }

    const apiKey = resolveApiKey(ctx.webSearch);
    if (!apiKey) {
      return {
        content:
          "Error: web_search is not configured — no Tavily API key. " +
          "The user must set one via `scissor config` (Web search) or the TAVILY_API_KEY " +
          "environment variable; get a key at https://tavily.com. " +
          "This is a dead end: do not retry web_search this session, continue without it.",
        isError: true,
      };
    }

    const doFetch = ctx.webSearch?.fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== "function") {
      return {
        content: "Error: web_search is unavailable — no fetch implementation in this runtime.",
        isError: true,
      };
    }

    const endpoint = ctx.webSearch?.endpoint ?? TAVILY_SEARCH_ENDPOINT;
    const abort = linkAbort(ctx.signal);
    try {
      const res = await doFetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query,
          max_results: maxResults,
          search_depth: searchDepth,
          include_answer: true,
        }),
        signal: abort.controller.signal,
      });

      if (!res.ok) {
        let body = "";
        try {
          body = await res.text();
        } catch {
          // Body is optional context for the error; its absence is not fatal.
        }
        return { content: describeHttpError(res.status, body), isError: true };
      }

      let data: TavilySearchResponse;
      try {
        data = (await res.json()) as TavilySearchResponse;
      } catch (err) {
        return {
          content: `Error: Tavily returned a response that is not valid JSON: ${(err as Error).message}`,
          isError: true,
        };
      }
      return { content: formatTavilyResponse(data, query) };
    } catch (err) {
      const error = err as Error;
      if (error.name === "AbortError") {
        return {
          content: ctx.signal?.aborted
            ? "Error: web_search was cancelled."
            : `Error: Tavily request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`,
          isError: true,
        };
      }
      return { content: `Error: web_search request failed: ${error.message}`, isError: true };
    } finally {
      abort.done();
    }
  },
};
