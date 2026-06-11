import type { ActionContext } from "../core";
import { captureScreenshot } from "../../../content/screenshot";
import { makeImageResult } from "../../tool-result";
import { waitForCondition } from "../interaction";

export async function handleScreenshot(
  ctx: ActionContext,
): Promise<string> {
  const tab = ctx.tabManager.getActiveTab();
  if (!tab) return "Error: No active tab";
  const wc = tab.view.webContents;
  const screenshotStart = Date.now();
  const shot = await captureScreenshot(wc);
  if (!shot.ok) return `Error: ${shot.error}`;
  const screenshotMs = Date.now() - screenshotStart;
  const title = wc.getTitle() || "(untitled)";
  const url = wc.getURL();
  return makeImageResult(
    shot.base64,
    `Screenshot of "${title}" (${url}) — ${shot.width}x${shot.height}, captured in ${screenshotMs}ms. Analyze the image to understand the current visual state of the page.`,
  );
}

export async function handleWaitFor(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const wc = ctx.tabManager.getActiveTab()?.view.webContents;
  if (!wc) return "Error: No active tab";
  return waitForCondition(wc, args);
}

export async function handleWaitForNavigation(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const wc = ctx.tabManager.getActiveTab()?.view.webContents;
  if (!wc) return "Error: No active tab";
  const timeout =
    typeof args.timeoutMs === "number" ? args.timeoutMs : 10000;
  const beforeUrl = wc.getURL();
  if (wc.isLoading()) {
    // Page is currently loading — wait for it to finish
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeout);
      wc.once("did-stop-loading", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  } else {
    // Page already loaded — wait briefly in case a navigation is about to start
    await new Promise<void>((resolve) => {
      let navigated = false;
      const timer = setTimeout(
        () => {
          if (!navigated) resolve();
        },
        Math.min(timeout, 2000),
      );
      wc.once("did-start-loading", () => {
        navigated = true;
        clearTimeout(timer);
        // Now wait for it to finish
        const loadTimer = setTimeout(resolve, timeout);
        wc.once("did-stop-loading", () => {
          clearTimeout(loadTimer);
          resolve();
        });
      });
    });
  }
  const afterUrl = wc.getURL();
  const title = wc.getTitle();
  if (afterUrl !== beforeUrl) {
    return `Navigation complete: ${title} (${afterUrl})`;
  }
  return `Page loaded: ${title} (${afterUrl})`;
}

export function handleMetrics(ctx: ActionContext): string {
  const m = ctx.runtime.getMetrics();
  const lines = [
    `Session Metrics:`,
    `  Total actions: ${m.totalActions}`,
    `  Completed: ${m.completedActions}`,
    `  Failed: ${m.failedActions}`,
    `  Average duration: ${m.averageDurationMs}ms`,
    ``,
    `Tool breakdown:`,
  ];
  for (const [name, stats] of Object.entries(m.toolBreakdown)) {
    lines.push(
      `  ${name}: ${stats.count} calls, avg ${stats.avgMs}ms${stats.errors > 0 ? `, ${stats.errors} errors` : ""}`,
    );
  }
  return lines.join("\n");
}

export function handleUndoLastAction(ctx: ActionContext): string {
  const undone = ctx.runtime.undoLastAction();
  if (!undone) return "Nothing to undo. No undo snapshots available.";
  return `Undid action: ${undone}. Browser restored to state before that action.`;
}
