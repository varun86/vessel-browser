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

const CLICK_TOOL = {
  name: "click",
  description: "Click a page element",
  input_schema: {
    type: "object",
    properties: { index: { type: "number" }, text: { type: "string" } },
  },
} as const;

const ALL_TOOLS = [CLICK_TOOL, READ_PAGE_TOOL];

function clickCall(callId: string, index: number) {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: callId,
      name: "click",
      arguments: JSON.stringify({ index }),
    },
  };
}

test(
  "Codex harness terminates when the model retries the same failed click target",
  { timeout: 10_000 },
  async () => {
    // Reproduces the transcript bug: the model tried click #45 (failed),
    // click #46 (failed), click #45 (failed again) — burning three turns
    // and producing no progress. The harness should terminate after the
    // second failure of the *same signature*, while still allowing the
    // model to try a *different* target in between.
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
        // First attempt on #45 — fails, but allowed (1st strike).
        return codexSseResponse([clickCall("call_click_1", 45)]);
      }
      if (requestCount === 2) {
        // Different target #46 — fails, but allowed (different signature).
        return codexSseResponse([clickCall("call_click_2", 46)]);
      }
      if (requestCount === 3) {
        // Retries #45 — same signature as turn 1, 2nd strike, harness
        // should terminate after this turn.
        return codexSseResponse([clickCall("call_click_3", 45)]);
      }
      return codexSseResponse([
        { type: "response.output_text.delta", delta: "unexpected 4th turn" },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "click the cheapest flight result",
        [...ALL_TOOLS],
        (chunk) => chunks.push(chunk),
        async (name, args) => {
          calls.push({ name, args });
          // All clicks fail — simulate the page-actions tool returning
          // one of the failure messages that looksLikeFailedToolOutput
          // catches (this is the wording clickResolvedSelector produces
          // when the page doesn't change after the click).
          return "Clicked: result link\nNote: Page did not change after click.";
        },
        () => undefined,
      ),
    );

    // Three click tool executions. The 3rd is the duplicate strike that
    // triggers termination.
    const clickCalls = calls.filter((c) => c.name === "click");
    assert.equal(
      clickCalls.length,
      3,
      "all three click attempts should have executed before termination",
    );

    // Three backend calls: turn 1, turn 2, turn 3 (which terminates).
    // No 4th backend call.
    assert.equal(
      requestBodies.length,
      3,
      "harness must terminate after the second click failure of the same signature",
    );

    // The failed-click recovery input must have been pushed on turns 1
    // and 2 (we test that the recovery advice is reaching the model
    // before we terminate). The first thing the model sees after the
    // first failed click is the recovery input mentioning the target.
    assert.match(
      JSON.stringify(requestBodies[1]?.input ?? []),
      /previous click did not complete for #45/i,
      "turn-2 input should include the click-failure recovery message naming #45",
    );
    assert.match(
      JSON.stringify(requestBodies[1]?.input ?? []),
      /Do not retry the same click target/,
      "turn-2 input should warn the model not to retry the same target",
    );

    // Termination chunk was emitted naming the failing target.
    const terminationChunks = chunks.filter((chunk) =>
      chunk.includes("<<task_complete: stopped after repeated failed click"),
    );
    assert.equal(
      terminationChunks.length,
      1,
      "expected exactly one repeated-failed-click termination chunk",
    );
    assert.equal(
      terminationChunks.some((chunk) => chunk.includes("#45")),
      true,
      "termination chunk should name the failing click target (#45)",
    );
  },
);

test(
  "Codex harness does NOT terminate when the model tries a different click target after a failure",
  { timeout: 10_000 },
  async () => {
    // The model legitimately fails on #45, then on #46, then on #47.
    // Each failure is a different signature, so the per-signature strike
    // counter never reaches 2 for any one target. The loop should
    // continue normally and exit via the model's natural final answer.
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
        return codexSseResponse([clickCall("call_click_1", 45)]);
      }
      if (requestCount === 2) {
        return codexSseResponse([clickCall("call_click_2", 46)]);
      }
      if (requestCount === 3) {
        return codexSseResponse([clickCall("call_click_3", 47)]);
      }
      // After three failed-but-different clicks, the model gives up
      // and answers. No termination chunk expected.
      return codexSseResponse([
        {
          type: "response.output_text.delta",
          delta: "I was unable to click through to flight results.",
        },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "click the cheapest flight result",
        [...ALL_TOOLS],
        (chunk) => chunks.push(chunk),
        async (name, args) => {
          calls.push({ name, args });
          return "Clicked: result link\nNote: Page did not change after click.";
        },
        () => undefined,
      ),
    );

    const clickCalls = calls.filter((c) => c.name === "click");
    assert.equal(
      clickCalls.length,
      3,
      "all three click attempts on different targets should have executed",
    );

    // No termination chunk from the click-strike logic.
    const terminationChunks = chunks.filter((chunk) =>
      chunk.includes("<<task_complete: stopped after repeated failed click"),
    );
    assert.equal(
      terminationChunks.length,
      0,
      "no click-strike termination should fire when targets differ",
    );

    // The model is allowed to keep trying — 4 backend calls (3 click
    // attempts + the final answer turn).
    assert.equal(requestBodies.length, 4);
  },
);

test(
  "Codex harness resets failed-click strikes after real progress",
  { timeout: 10_000 },
  async () => {
    // A click target can become meaningful again after the page advances.
    // The first #45 failure should not poison a later #45 attempt once a
    // different click has made real progress in between.
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
        return codexSseResponse([clickCall("call_click_1", 45)]);
      }
      if (requestCount === 2) {
        return codexSseResponse([clickCall("call_click_2", 46)]);
      }
      if (requestCount === 3) {
        return codexSseResponse([clickCall("call_click_3", 45)]);
      }
      return codexSseResponse([
        {
          type: "response.output_text.delta",
          delta: "I advanced with another result and continued normally.",
        },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "click the cheapest flight result",
        [...ALL_TOOLS],
        (chunk) => chunks.push(chunk),
        async (name, args) => {
          calls.push({ name, args });
          if (args.index === 46) {
            return "Clicked: result link\nNavigated to https://example.test/result";
          }
          return "Clicked: result link\nNote: Page did not change after click.";
        },
        () => undefined,
      ),
    );

    const clickCalls = calls.filter((c) => c.name === "click");
    assert.equal(
      clickCalls.length,
      3,
      "the later #45 attempt should execute as a fresh first strike after real progress",
    );

    const terminationChunks = chunks.filter((chunk) =>
      chunk.includes("<<task_complete: stopped after repeated failed click"),
    );
    assert.equal(
      terminationChunks.length,
      0,
      "real progress should clear earlier failed-click strikes",
    );

    assert.equal(
      requestBodies.length,
      4,
      "harness should continue after the later #45 failure instead of terminating",
    );
  },
);
