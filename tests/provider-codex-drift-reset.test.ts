import assert from "node:assert/strict";
import test from "node:test";

import { CodexProvider } from "../src/main/ai/provider-codex";

// --- fetch / SSE helpers (mirrors tests/security-hardening.test.ts) ---

async function withMockFetch<T>(
  handler: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Response | Promise<Response>,
  fn: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function codexSseResponse(
  events: Array<Record<string, unknown>>,
  headers: Record<string, string> = {},
): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        ...headers,
      },
    },
  );
}

function codexTokens() {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    idToken: "",
    expiresAt: Date.now() + 60 * 60 * 1000,
    accountId: "account-123",
  };
}

const WEB_SEARCH_TOOL = {
  name: "web_search",
  description: "Search the open web",
  input_schema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
} as const;

const READ_PAGE_TOOL = {
  name: "read_page",
  description: "Read current page",
  input_schema: { type: "object", properties: {} },
} as const;

const NAVIGATE_TOOL = {
  name: "navigate",
  description: "Navigate to a URL",
  input_schema: {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
  },
} as const;

const FLIGHT_QUERY = "cheapest flight tomorrow from Portland to San Francisco";
const BAGGAGE_QUERY = "Alaska Airlines checked baggage policy";

function webSearchCall(callId: string, query: string) {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: callId,
      name: "web_search",
      arguments: JSON.stringify({ query }),
    },
  };
}

function navigateCall(callId: string, url: string) {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: callId,
      name: "navigate",
      arguments: JSON.stringify({ url }),
    },
  };
}

function searchResultOutput(query: string): string {
  const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
  return [
    `Web searched "${query}" via default search engine → ${url}`,
    `[state: url=${url}, title="DuckDuckGo Search"]`,
  ].join("\n");
}

test(
  "drift check does NOT fire on a legitimately distinct second web_search after real progress",
  { timeout: 10_000 },
  async () => {
    // Regression: a session-long counter (`successfulWebSearchCount > 0`)
    // caused the drift check to fire on the first distinct web_search in
    // the session, terminating the loop after a single strike. The fix
    // ties drift detection to the *immediately preceding* successful
    // web_search query and clears it on any real-progress tool — so a
    // model that does search → click → search (different query) is NOT
    // flagged as drifting.
    const provider = new CodexProvider(codexTokens(), "gpt-5");
    const chunks: string[] = [];
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const requestBodies: Array<Record<string, unknown>> = [];

    await withMockFetch(async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      );
      const requestCount = requestBodies.length;

      if (requestCount === 1) {
        // First search: "cheapest flight PDX to SFO"
        return codexSseResponse([webSearchCall("call_ws_1", FLIGHT_QUERY)]);
      }
      if (requestCount === 2) {
        // Model navigates to a result — REAL progress. This clears
        // lastSuccessfulWebSearchQuery, so the next distinct web_search
        // is NOT flagged as drift.
        return codexSseResponse([
          navigateCall("call_nav_1", "https://www.alaskaair.com/"),
        ]);
      }
      if (requestCount === 3) {
        // Distinct search on a different topic. With the fix this
        // executes normally; the previous design would have flagged
        // it as "(drifted)" and after the second strike terminated.
        return codexSseResponse([webSearchCall("call_ws_2", BAGGAGE_QUERY)]);
      }
      if (requestCount === 4) {
        return codexSseResponse([
          {
            type: "response.output_text.delta",
            delta: "Here is the baggage policy summary.",
          },
        ]);
      }
      return codexSseResponse([
        { type: "response.output_text.delta", delta: "unexpected 5th turn" },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "find the cheapest flight tomorrow from portland to sfo, then check the baggage policy",
        [WEB_SEARCH_TOOL, READ_PAGE_TOOL, NAVIGATE_TOOL],
        (chunk) => chunks.push(chunk),
        async (name, args) => {
          calls.push({ name, args });
          if (name === "web_search") {
            const query = typeof args.query === "string" ? args.query : "";
            return searchResultOutput(query);
          }
          if (name === "navigate") {
            return "Navigated to https://www.alaskaair.com/";
          }
          return "page snapshot";
        },
        () => undefined,
      ),
    );

    // Both searches executed because real progress (navigate) cleared
    // the lastSuccessfulWebSearchQuery anchor between them. The previous
    // implementation would have flagged the second search as "(drifted)"
    // on the first strike and then terminated the loop.
    const webSearchCalls = calls.filter((c) => c.name === "web_search");
    assert.equal(
      webSearchCalls.length,
      2,
      "both distinct web_search calls should execute (drift check should not fire after real progress)",
    );
    assert.equal(webSearchCalls[0]?.args?.query, FLIGHT_QUERY);
    assert.equal(webSearchCalls[1]?.args?.query, BAGGAGE_QUERY);

    // No drift-suppression chunk.
    const driftSuppressionChunks = chunks.filter((chunk) =>
      chunk.includes("<<tool:web_search:↻ duplicate suppressed>>"),
    );
    assert.equal(
      driftSuppressionChunks.length,
      0,
      "no drift suppression should fire on a legitimately distinct query after real progress",
    );

    // No termination chunk from the search-strike logic.
    const terminationChunks = chunks.filter((chunk) =>
      chunk.includes("<<task_complete: stopped after duplicate search"),
    );
    assert.equal(
      terminationChunks.length,
      0,
      "no search-strike termination should fire on legitimate distinct searches",
    );

    // Loop completed naturally (4 backend calls: search + nav +
    // search + answer).
    assert.equal(
      requestBodies.length,
      4,
      "harness should not terminate early on distinct legitimate searches",
    );
  },
);

test(
  "drift check DOES fire and terminate on repeated drifted web_search with no progress",
  { timeout: 10_000 },
  async () => {
    // The reverse case: the model issues a web_search, then a DIFFERENT
    // web_search with no real progress in between. The drift check
    // should still catch this — first strike is the actionable error,
    // second strike terminates. This is the *real* drift pattern (model
    // is flailing between queries) and the harness must still stop it.
    const provider = new CodexProvider(codexTokens(), "gpt-5");
    const chunks: string[] = [];
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const requestBodies: Array<Record<string, unknown>> = [];

    await withMockFetch(async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      );
      const requestCount = requestBodies.length;

      if (requestCount === 1) {
        return codexSseResponse([webSearchCall("call_ws_1", FLIGHT_QUERY)]);
      }
      if (requestCount === 2) {
        // Distinct query, no real progress in between — 1st drift strike.
        return codexSseResponse([
          webSearchCall("call_ws_2", "cheap airfare PDX SFO one way"),
        ]);
      }
      if (requestCount === 3) {
        // Another distinct query — 2nd drift strike, harness terminates.
        return codexSseResponse([
          webSearchCall("call_ws_3", "lowest fare Portland to San Francisco"),
        ]);
      }
      return codexSseResponse([
        { type: "response.output_text.delta", delta: "unexpected 4th turn" },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "find the cheapest flight tomorrow from portland to sfo",
        [WEB_SEARCH_TOOL, READ_PAGE_TOOL],
        (chunk) => chunks.push(chunk),
        async (name, args) => {
          calls.push({ name, args });
          if (name === "web_search") {
            const query = typeof args.query === "string" ? args.query : "";
            return searchResultOutput(query);
          }
          return "page snapshot";
        },
        () => undefined,
      ),
    );

    // Only the first web_search executed; the next two were caught by
    // the drift check before reaching the executor.
    const webSearchCalls = calls.filter((c) => c.name === "web_search");
    assert.equal(
      webSearchCalls.length,
      1,
      "only the first web_search should execute; the rest are drift strikes",
    );

    // Both drift-suppression chunks appeared.
    const driftSuppressionChunks = chunks.filter((chunk) =>
      chunk.includes("<<tool:web_search:↻ duplicate suppressed>>"),
    );
    assert.equal(
      driftSuppressionChunks.length,
      2,
      "expected one drift suppression chunk per strike",
    );

    // Termination chunk was emitted and includes the prior successful
    // web_search query (not the literal '(drifted)'). The query is
    // lowercased in the chunk because normalizedSearchToolQuery strips
    // case for comparison.
    const terminationChunks = chunks.filter((chunk) =>
      chunk.includes("<<task_complete: stopped after duplicate search"),
    );
    assert.equal(
      terminationChunks.length,
      1,
      "expected exactly one search-strike termination chunk",
    );
    assert.equal(
      terminationChunks[0]?.includes(FLIGHT_QUERY.toLowerCase()),
      true,
      "termination chunk should name the prior successful query verbatim, not '(drifted)'",
    );

    // Three backend calls (1st executes, 2nd = 1st strike, 3rd = 2nd
    // strike → terminate).
    assert.equal(
      requestBodies.length,
      3,
      "harness must terminate after the second drift strike without making a 4th backend call",
    );
  },
);
