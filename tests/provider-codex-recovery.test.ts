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

const CLICK_TOOL = {
  name: "click",
  description: "Click a page element",
  input_schema: {
    type: "object",
    properties: { index: { type: "number" }, text: { type: "string" } },
  },
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

test(
  "Codex harness does NOT nudge the model when it says 'I've navigated' or 'I'll now click'",
  { timeout: 10_000 },
  async () => {
    // Regression: the previous shouldRetryCodexToolLoop treated
    // "I've navigated", "I'll now", "next I'll", "I will now" as
    // STALL signals and pushed a `[System] The task is still in
    // progress: ...` recovery message with `<<erase_prev>>` to
    // force the model to keep working. That erased the model's
    // natural progress narrative ("I've navigated to the airline
    // site, now I'll click the result") and confused it.
    //
    // The new logic only nudges on real stalls: empty text, an
    // explicit user-question, or a "I cannot proceed" signal.
    // Forward-looking language is now allowed to be a natural
    // completion.
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
        // First: model searches
        return codexSseResponse([
          webSearchCall("call_ws", "cheapest flight PDX SFO"),
        ]);
      }
      if (requestCount === 2) {
        // Second: model navigates (real progress, no tool call
        // suppression, just executes)
        return codexSseResponse([
          navigateCall("call_nav", "https://www.alaskaair.com/"),
        ]);
      }
      // Third turn: model emits progress narrative "I've
      // navigated to the airline site, now I'll click the result"
      // — a NATURAL forward-looking phrase. The OLD harness would
      // have nudged here with a recovery message. The NEW
      // harness should let the model finish (no tool call → break).
      return codexSseResponse([
        {
          type: "response.output_text.delta",
          delta:
            "I've navigated to the airline site. Next, I'll click the cheapest flight result.",
        },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "find the cheapest flight from PDX to SFO",
        [WEB_SEARCH_TOOL, READ_PAGE_TOOL, NAVIGATE_TOOL],
        (chunk) => chunks.push(chunk),
        async (name, args) => {
          calls.push({ name, args });
          if (name === "web_search") {
            return `Web searched via default search engine → https://duckduckgo.com/\n[state: url=https://duckduckgo.com/, title="DuckDuckGo"]`;
          }
          if (name === "navigate") {
            return "Navigated to https://www.alaskaair.com/";
          }
          return "page snapshot";
        },
        () => undefined,
      ),
    );

    // The web_search and navigate actually executed.
    const ws = calls.filter((c) => c.name === "web_search");
    const nav = calls.filter((c) => c.name === "navigate");
    assert.equal(ws.length, 1, "first web_search should execute");
    assert.equal(nav.length, 1, "navigate should execute");

    // 3 backend calls — the third turn emitted the forward-looking
    // narrative, the harness did NOT nudge, and the loop broke
    // naturally. (If the harness had nudged, there would be a 4th
    // backend call.)
    assert.equal(
      requestBodies.length,
      3,
      "harness should NOT nudge on 'I've navigated' or 'next, I'll' — let the model finish",
    );

    // No erase_prev chunks (the recovery path emits those to wipe
    // the model's just-typed text).
    const eraseChunks = chunks.filter((chunk) =>
      chunk.includes("<<erase_prev>>"),
    );
    assert.equal(
      eraseChunks.length,
      0,
      "harness should NOT erase the model's natural progress narrative",
    );

    // No recovery [System] nudge in the third-turn input. We can
    // detect this by checking the 3rd backend call's input doesn't
    // contain "task is still in progress".
    const lastInput = JSON.stringify(requestBodies[2]?.input ?? []);
    assert.doesNotMatch(
      lastInput,
      /task is still in progress/i,
      "harness should NOT push a 'task is still in progress' nudge on forward-looking text",
    );
  },
);

test(
  "Codex harness DOES nudge when the model gives up with 'I cannot proceed'",
  { timeout: 10_000 },
  async () => {
    // Counter-test: the new logic still nudges on real stalls.
    // A model that says "I cannot see the current page" or "I'm
    // unable to click" has genuinely stalled and should get a
    // [System] nudge.
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
        return codexSseResponse([readPageCall("call_read")]);
      }
      if (requestCount === 2) {
        // Model says it cannot see the page (real stall).
        return codexSseResponse([
          {
            type: "response.output_text.delta",
            delta:
              "I cannot see the current page state, so I cannot click the right element.",
          },
        ]);
      }
      if (requestCount === 3) {
        // After the nudge, the model should retry with a tool call.
        return codexSseResponse([
          readPageCall("call_read_2"),
        ]);
      }
      // After the second read_page, the model gives a final
      // answer.
      return codexSseResponse([
        {
          type: "response.output_text.delta",
          delta: "I have enough context now.",
        },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "do something on the current page",
        [READ_PAGE_TOOL, CLICK_TOOL],
        (chunk) => chunks.push(chunk),
        async (name) => {
          calls.push({ name, args: {} });
          return "Page snapshot";
        },
        () => undefined,
      ),
    );

    // Recovery nudge pushed a [System] message on the 3rd backend
    // call. The 3rd turn's input should contain the recovery
    // prompt.
    const nudgeInput = JSON.stringify(requestBodies[2]?.input ?? []);
    assert.match(
      nudgeInput,
      /task is still in progress/i,
      "harness should push the recovery prompt on a real stall ('I cannot')",
    );

    // The model did retry (2 read_page calls executed).
    const readPageCalls = calls.filter((c) => c.name === "read_page");
    assert.equal(
      readPageCalls.length,
      2,
      "model should retry after the recovery nudge",
    );
  },
);

test(
  "Codex harness caps recovery nudges at 1 (no second nudge on persistent stall)",
  { timeout: 10_000 },
  async () => {
    // The previous code had `recoveryCount < 2`, allowing TWO
    // recovery nudges per session. The new code caps at 1. A model
    // that keeps stalling after one nudge should be allowed to
    // give its final answer (or the loop should exit naturally).
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
        return codexSseResponse([readPageCall("call_read_1")]);
      }
      if (requestCount === 2) {
        // Real stall — 1st nudge fires.
        return codexSseResponse([
          {
            type: "response.output_text.delta",
            delta: "I cannot proceed without more context.",
          },
        ]);
      }
      if (requestCount === 3) {
        // After the nudge, the model STALLS AGAIN with the same
        // "I cannot" wording. The OLD harness would have nudged
        // a second time (recoveryCount < 2). The NEW harness
        // should NOT nudge again — it's the second time the model
        // has stalled, so the harness accepts the model's
        // self-reported inability and breaks the loop.
        return codexSseResponse([
          {
            type: "response.output_text.delta",
            delta: "I cannot proceed. I cannot see the page.",
          },
        ]);
      }
      // If the harness did nudge a 2nd time, we'd see a 4th turn.
      return codexSseResponse([
        {
          type: "response.output_text.delta",
          delta: "unexpected 4th turn",
        },
      ]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "do something",
        [READ_PAGE_TOOL],
        (chunk) => chunks.push(chunk),
        async (name) => {
          calls.push({ name, args: {} });
          return "Page snapshot";
        },
        () => undefined,
      ),
    );

    // 3 backend calls: search, 1st nudge fires, 2nd stall exits.
    // (The OLD harness would have produced 4: search, 1st nudge,
    // 2nd nudge fires, then a 4th turn.)
    assert.equal(
      requestBodies.length,
      3,
      "harness should cap recovery nudges at 1 and accept the model's 2nd stall as final",
    );

    // The 3rd backend call's input is the 1st recovery nudge
    // (pushed in response to the 2nd-turn stall). The harness
    // should NOT have produced a 4th backend call (no 2nd nudge).
    const nudgeInput = JSON.stringify(requestBodies[2]?.input ?? []);
    assert.match(
      nudgeInput,
      /task is still in progress/i,
      "1st stall should fire a recovery nudge (seen as input to the 3rd backend call)",
    );
  },
);

test(
  "Codex harness softens the failed-click recovery input (no over-prescriptive target guidance)",
  { timeout: 10_000 },
  async () => {
    // The previous failed-click recovery input said "Avoid filters,
    // sort controls, snippets, timestamps, and non-link text" and
    // "Do not retry the same click target". The new version just
    // says "the click did not complete, take the next step" — no
    // prescriptive list. This test pins the new wording.
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
        // First click fails.
        return codexSseResponse([clickCall("call_click_1", 12)]);
      }
      // After the failed click, the model retries with a
      // different target — the loop continues naturally.
      return codexSseResponse([clickCall("call_click_2", 13)]);
    }, () =>
      provider.streamAgentQuery(
        "system prompt",
        "click the second result",
        [CLICK_TOOL, READ_PAGE_TOOL],
        (chunk) => chunks.push(chunk),
        async (name) => {
          calls.push({ name, args: {} });
          return "Clicked: result link\nNote: Page did not change after click.";
        },
        () => undefined,
      ),
    );

    // The recovery input is pushed on the 2nd turn (after the
    // failed click). It should mention the failed target but
    // should NOT contain the over-prescriptive target guidance.
    const turn2Input = JSON.stringify(requestBodies[1]?.input ?? []);
    assert.match(
      turn2Input,
      /previous click did not complete/i,
      "recovery input should mention the failed click",
    );
    assert.match(
      turn2Input,
      /#12/,
      "recovery input should name the failing target",
    );
    // The over-prescriptive language should be gone.
    assert.doesNotMatch(
      turn2Input,
      /Avoid filters, sort controls, snippets, timestamps/i,
      "recovery input should not over-prescribe which targets to avoid",
    );
    assert.doesNotMatch(
      turn2Input,
      /Do not retry the same click target/i,
      "recovery input should not forbid retrying the same target (the model may need to)",
    );
  },
);
