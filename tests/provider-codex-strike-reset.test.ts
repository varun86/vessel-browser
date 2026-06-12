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

const ALL_TOOLS = [WEB_SEARCH_TOOL, READ_PAGE_TOOL];

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

function searchResultOutput(query: string): string {
  return [
    `Web searched "${query}" via default search engine → https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
    "[state: url=https://duckduckgo.com/?q=" +
      encodeURIComponent(query) +
      ', title="DuckDuckGo Search"]',
  ].join("\n");
}

test(
  "search dedup strikes reset after a successful read_page so the next duplicate does not trip the limit",
  { timeout: 10_000 },
  async () => {
    const provider = new CodexProvider(codexTokens(), "gpt-5");
    const chunks: string[] = [];
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const requestBodies: Array<Record<string, unknown>> = [];

    await withMockFetch(async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      );
      const requestCount = requestBodies.length;

      // Turn 1: first web_search → execute.
      if (requestCount === 1) {
        return codexSseResponse([webSearchCall("call_ws_1", FLIGHT_QUERY)]);
      }
      // Turn 2: model repeats web_search → 1st strike, harness tells the
      // model to recover.
      if (requestCount === 2) {
        return codexSseResponse([webSearchCall("call_ws_2", FLIGHT_QUERY)]);
      }
      // Turn 3: model takes the hint and calls read_page instead. This is
      // a real-progress tool call — the harness should reset the search
      // dedup strikes to 0.
      if (requestCount === 3) {
        return codexSseResponse([readPageCall("call_read_1")]);
      }
      // Turn 4: model repeats the original web_search AGAIN. Because the
      // strikes were reset on turn 3, this should be a fresh 1st strike
      // (NOT the 2nd strike that would terminate the loop).
      if (requestCount === 4) {
        return codexSseResponse([webSearchCall("call_ws_3", FLIGHT_QUERY)]);
      }
      // Turn 5: model repeats one more time — this IS the 2nd strike in
      // the post-reset window, so the harness should terminate.
      if (requestCount === 5) {
        return codexSseResponse([webSearchCall("call_ws_4", FLIGHT_QUERY)]);
      }
      // 6th turn should never happen.
      return codexSseResponse([
        { type: "response.output_text.delta", delta: "unexpected 6th turn" },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "can you help me find the cheapest flight for tomorrow from portland to san francisco?",
        [...ALL_TOOLS],
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
              "2. United Airlines $112 — nonstop, 1h 30m",
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

    // Tool executions: 1 web_search + 1 read_page + 0 more (the rest are
    // suppressed by the dedup).
    const webSearchCalls = calls.filter((c) => c.name === "web_search");
    const readPageCalls = calls.filter((c) => c.name === "read_page");
    assert.equal(webSearchCalls.length, 1, "web_search should run exactly once");
    assert.equal(readPageCalls.length, 1, "read_page should run exactly once");

    // Five backend calls: turn 1 execute; turn 2 1st-strike; turn 3 read
    // (strike reset); turn 4 fresh-1st-strike (because reset); turn 5
    // post-reset-2nd-strike → terminate.
    assert.equal(
      requestBodies.length,
      5,
      "harness must terminate after the second post-reset strike",
    );

    // The strike count progression: turn 2 = 1st strike, turn 4 = 1st
    // strike (post-reset), turn 5 = 2nd strike (terminates). That's 3
    // suppression chunks total.
    const suppressionChunks = chunks.filter((chunk) =>
      chunk.includes("<<tool:web_search:↻ duplicate suppressed>>"),
    );
    assert.equal(
      suppressionChunks.length,
      3,
      "expected three ↻ duplicate suppressed chunks (1 + reset + 2)",
    );

    // Exactly one task_complete termination chunk, emitted after the 5th
    // turn.
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
