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

function readPageCall(callId: string) {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: callId,
      name: "read_page",
      arguments: "{}",
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
  return [
    `Web searched "${query}" via default search engine → https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
    "[state: url=https://duckduckgo.com/?q=" +
      encodeURIComponent(query) +
      ', title="DuckDuckGo Search"]',
  ].join("\n");
}

test(
  "search dedup strikes do NOT reset on a successful read_page (prevents the read_page-gaming pattern)",
  { timeout: 10_000 },
  async () => {
    // The model in production gamed the previous version of the harness by
    // alternating `web_search → read_page → web_search → read_page` so the
    // read_page success kept resetting the strike counter. With read_page
    // excluded from the real-progress reset set, the second web_search
    // strike terminates the loop even if the model keeps reading the page
    // in between.
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
        return codexSseResponse([readPageCall("call_read_1")]);
      }
      if (requestCount === 3) {
        return codexSseResponse([webSearchCall("call_ws_2", FLIGHT_QUERY)]);
      }
      if (requestCount === 4) {
        return codexSseResponse([readPageCall("call_read_2")]);
      }
      if (requestCount === 5) {
        return codexSseResponse([webSearchCall("call_ws_3", FLIGHT_QUERY)]);
      }
      // 6th turn should never happen.
      return codexSseResponse([
        { type: "response.output_text.delta", delta: "unexpected 6th turn" },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "can you help me find the cheapest flight for tomorrow from portland to san francisco?",
        [WEB_SEARCH_TOOL, READ_PAGE_TOOL],
        (chunk) => chunks.push(chunk),
        async (name, args) => {
          calls.push({ name, args });
          if (name === "web_search") {
            return searchResultOutput(FLIGHT_QUERY);
          }
          if (name === "read_page") {
            return [
              "Page shows 10 flight results.",
              "1. Alaska Airlines $89 — nonstop, 1h 25m",
              "[state: url=https://duckduckgo.com/?q=" +
                encodeURIComponent(FLIGHT_QUERY) +
                ', title="DuckDuckGo Search"]',
            ].join("\n");
          }
          return "ok";
        },
        () => undefined,
      ),
    );

    // Tool executions: 1 web_search + 2 read_pages. The 2nd, 3rd, and 4th
    // web_search attempts are all deduped (turn 1 is the 1st strike, turn
    // 3 is the 2nd strike which terminates the loop before the 4th can be
    // asked).
    const webSearchCalls = calls.filter((c) => c.name === "web_search");
    const readPageCalls = calls.filter((c) => c.name === "read_page");
    assert.equal(
      webSearchCalls.length,
      1,
      "web_search should run exactly once (the first attempt)",
    );
    assert.equal(
      readPageCalls.length,
      2,
      "read_page should run twice (the model is allowed to actually read the page)",
    );

    // Five backend calls — the 5th is the second-strike that terminates.
    assert.equal(
      requestBodies.length,
      5,
      "harness must terminate on the second web_search strike despite intervening read_pages",
    );

    // Two web_search suppression chunks (one per strike).
    const suppressionChunks = chunks.filter((chunk) =>
      chunk.includes("<<tool:web_search:↻ duplicate suppressed>>"),
    );
    assert.equal(
      suppressionChunks.length,
      2,
      "expected two web_search suppression chunks",
    );

    // Exactly one termination chunk.
    const terminationChunks = chunks.filter((chunk) =>
      chunk.includes("<<task_complete: stopped after duplicate search"),
    );
    assert.equal(
      terminationChunks.length,
      1,
      "expected exactly one <<task_complete: stopped after duplicate search>> chunk",
    );
  },
);

test(
  "search dedup strikes DO reset on a real progress tool like navigate",
  { timeout: 10_000 },
  async () => {
    // A real forward-progress action (navigate) means the model has used
    // the prior search result in some way — the next duplicate search
    // (e.g. on a new page) is a fresh 1st strike, not a 2nd strike that
    // would terminate the loop.
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
        // 1st strike: harness tells the model to recover.
        return codexSseResponse([webSearchCall("call_ws_2", FLIGHT_QUERY)]);
      }
      if (requestCount === 3) {
        // Model navigates to one of the search results — real progress.
        return codexSseResponse([
          navigateCall(
            "call_nav_1",
            "https://www.alaskaair.com/search?from=PDX&to=SFO",
          ),
        ]);
      }
      if (requestCount === 4) {
        // Same query again, but the strike counter was reset on turn 3
        // (navigate is a real progress tool), so this is a fresh 1st
        // strike — not a 2nd strike that would terminate.
        return codexSseResponse([webSearchCall("call_ws_3", FLIGHT_QUERY)]);
      }
      if (requestCount === 5) {
        // 2nd strike in the post-reset window → terminate.
        return codexSseResponse([webSearchCall("call_ws_4", FLIGHT_QUERY)]);
      }
      return codexSseResponse([
        { type: "response.output_text.delta", delta: "unexpected 6th turn" },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "can you help me find the cheapest flight for tomorrow from portland to san francisco?",
        [WEB_SEARCH_TOOL, READ_PAGE_TOOL, NAVIGATE_TOOL],
        (chunk) => chunks.push(chunk),
        async (name, args) => {
          calls.push({ name, args });
          if (name === "web_search") {
            return searchResultOutput(FLIGHT_QUERY);
          }
          if (name === "read_page") {
            return "Page snapshot";
          }
          if (name === "navigate") {
            return "Navigated to https://www.alaskaair.com/search?from=PDX&to=SFO";
          }
          return "ok";
        },
        () => undefined,
      ),
    );

    // Tool executions: 1 web_search + 1 navigate.
    const webSearchCalls = calls.filter((c) => c.name === "web_search");
    const navigateCalls = calls.filter((c) => c.name === "navigate");
    assert.equal(
      webSearchCalls.length,
      1,
      "web_search should run exactly once (the first attempt)",
    );
    assert.equal(navigateCalls.length, 1, "navigate should run exactly once");

    // Five backend calls — same shape as the original reset test, but the
    // resetting tool is navigate (real progress) instead of read_page.
    assert.equal(requestBodies.length, 5);

    // Three suppression chunks: 1st strike, post-reset 1st strike,
    // post-reset 2nd strike.
    const suppressionChunks = chunks.filter((chunk) =>
      chunk.includes("<<tool:web_search:↻ duplicate suppressed>>"),
    );
    assert.equal(
      suppressionChunks.length,
      3,
      "expected three ↻ duplicate suppressed chunks (1 + reset + 2)",
    );

    // Exactly one termination chunk.
    const terminationChunks = chunks.filter((chunk) =>
      chunk.includes("<<task_complete: stopped after duplicate search"),
    );
    assert.equal(
      terminationChunks.length,
      1,
      "expected exactly one <<task_complete: stopped after duplicate search>> chunk",
    );
  },
);
