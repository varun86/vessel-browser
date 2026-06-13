import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { app } from "electron";

import { handleClearHighlights } from "../src/main/ai/page-actions/handlers/highlights";
import * as highlightsManager from "../src/main/highlights/manager";
import type { ActionContext } from "../src/main/ai/page-actions/core";

test("browser-agent clear_highlights removes persisted highlights for the current page", async () => {
  const userDataPath = app.getPath("userData");
  mkdirSync(userDataPath, { recursive: true });
  writeFileSync(
    path.join(userDataPath, "vessel-highlights.json"),
    JSON.stringify({ highlights: [] }),
  );

  const url = "https://news.ycombinator.com/item?id=123#comments";
  const normalizedUrl = highlightsManager.normalizeUrl(url);
  highlightsManager.clearHighlightsForUrl(normalizedUrl);

  highlightsManager.addHighlight(
    normalizedUrl,
    undefined,
    "MAI-Code-1-Flash",
    "important story",
    "green",
    "agent",
  );

  assert.equal(highlightsManager.getHighlightsForUrl(url).length, 1);

  const ctx = {
    tabManager: {
      getActiveTab: () => ({
        view: {
          webContents: {
            getURL: () => url,
            executeJavaScript: async () => "Cleared 1 highlight",
          },
        },
      }),
    },
  } as unknown as ActionContext;

  const result = await handleClearHighlights(ctx);

  assert.equal(result, "Cleared 1 highlight");
  assert.equal(highlightsManager.getHighlightsForUrl(url).length, 0);
});
