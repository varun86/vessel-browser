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

const READ_PAGE_TOOL = {
  name: "read_page",
  description: "Read current page",
  input_schema: { type: "object", properties: {} },
} as const;

const CLEAR_OVERLAYS_TOOL = {
  name: "clear_overlays",
  description: "Clear blocking overlays on the current page",
  input_schema: { type: "object", properties: {} },
} as const;

const ALL_TOOLS = [CLEAR_OVERLAYS_TOOL, READ_PAGE_TOOL];

function clearOverlaysCall(callId: string) {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: callId,
      name: "clear_overlays",
      arguments: "{}",
    },
  };
}

test(
  "Codex harness terminates after the second fabricated clear_overlays strike",
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

      // Turn 1: model fabricates a clear_overlays call with no overlay
      // signal in the system prompt or any prior tool result (1st strike).
      if (requestCount === 1) {
        return codexSseResponse([clearOverlaysCall("call_clear_1")]);
      }
      // Turn 2: model fabricates a second clear_overlays call (2nd strike
      // — harness should terminate after this turn, NOT make a 3rd backend
      // call).
      if (requestCount === 2) {
        return codexSseResponse([clearOverlaysCall("call_clear_2")]);
      }
      // If the harness asks for a 3rd turn, the model is no longer
      // listening to the dedup error and the test fails.
      return codexSseResponse([
        { type: "response.output_text.delta", delta: "unexpected 3rd turn" },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "can you help me find the cheapest flight for tomorrow from portland to san francisco?",
        [...ALL_TOOLS],
        (chunk) => chunks.push(chunk),
        async (name, args) => {
          calls.push({ name, args });
          // The executor returns "No blocking overlays detected" — this is
          // what the underlying page-actions tool would return when there
          // is genuinely no overlay. The harness should never reach this
          // path because the dedup check fires before the tool is called.
          return "No blocking overlays detected on this page";
        },
        () => undefined,
      ),
    );

    // The tool was never executed — every clear_overlays call was caught
    // by the dedup check before it reached the executor.
    assert.deepEqual(calls, []);

    // Two backend calls: turn 1 = 1st fabricated clear_overlays (1st
    // strike, suppressed with actionable error); turn 2 = 2nd fabricated
    // clear_overlays (2nd strike, terminate without asking the backend for
    // a 3rd turn).
    assert.equal(
      requestBodies.length,
      2,
      "harness must terminate after the second strike without making a 3rd backend call",
    );

    // Both duplicate-suppressed chunk markers were emitted.
    const suppressionChunks = chunks.filter((chunk) =>
      chunk.includes("<<tool:clear_overlays:↻ duplicate suppressed>>"),
    );
    assert.equal(
      suppressionChunks.length,
      2,
      "expected one ↻ duplicate suppressed chunk per strike",
    );

    // The harness emits a task_complete marker.
    assert.equal(
      chunks.some((chunk) =>
        chunk.includes(
          "<<task_complete: stopped after fabricated clear_overlays",
        ),
      ),
      true,
      "expected a <<task_complete: stopped after fabricated clear_overlays>> chunk",
    );

    // The actionable error message made it into the second backend request
    // (the request the harness sent *after* the 1st strike, asking the
    // model to recover).
    assert.match(
      JSON.stringify(requestBodies[1]?.input ?? []),
      /No blocking overlay signal is present/,
      "second-turn input should include the new actionable overlay error",
    );
    assert.match(
      JSON.stringify(requestBodies[1]?.input ?? []),
      /Do not call clear_overlays again/,
      "second-turn input should explicitly forbid repeating the tool",
    );
  },
);

test(
  "Codex harness does not fire clear_overlays termination when an overlay signal IS present",
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

      // Turn 1: a read_page returns a real overlay signal.
      if (requestCount === 1) {
        return codexSseResponse([
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: "call_read_1",
              name: "read_page",
              arguments: "{}",
            },
          },
        ]);
      }
      // Turn 2: model calls clear_overlays legitimately because the read
      // result reported a blocking overlay.
      if (requestCount === 2) {
        return codexSseResponse([clearOverlaysCall("call_clear_legit")]);
      }
      // Turn 3: model gives a final answer.
      return codexSseResponse([
        {
          type: "response.output_text.delta",
          delta: "Overlay cleared, continuing with the flight search.",
        },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "can you help me find the cheapest flight for tomorrow from portland to san francisco?",
        [...ALL_TOOLS],
        (chunk) => chunks.push(chunk),
        async (name, args) => {
          calls.push({ name, args });
          if (name === "read_page") {
            return [
              "Page shows flight results.",
              "Warning: blocking overlay detected — cookie consent dialog covering the page.",
              "[state: url=https://www.google.com/travel/flights, title=\"Flights\"]",
            ].join("\n");
          }
          return "Overlay cleared successfully";
        },
        () => undefined,
      ),
    );

    // read_page executed once, clear_overlays executed once.
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.name, "read_page");
    assert.equal(calls[1]?.name, "clear_overlays");

    // No duplicate-suppressed chunks for clear_overlays — the dedup should
    // not fire when there's a real overlay signal.
    const suppressionChunks = chunks.filter((chunk) =>
      chunk.includes("<<tool:clear_overlays:↻ duplicate suppressed>>"),
    );
    assert.equal(
      suppressionChunks.length,
      0,
      "clear_overlays dedup must not fire when an overlay signal is present",
    );

    // No task_complete:stopped chunk for clear_overlays.
    assert.equal(
      chunks.some((chunk) =>
        chunk.includes("<<task_complete: stopped after fabricated clear_overlays"),
      ),
      false,
      "no fabricated-clear_overlays termination should occur",
    );
  },
);
