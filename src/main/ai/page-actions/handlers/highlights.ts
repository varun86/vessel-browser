import type { ActionContext } from "../core";
import * as highlightsManager from "../../../highlights/manager";
import { highlightOnPage, clearHighlights } from "../../../highlights/inject";
import { resolveSelector } from "../../../utils/selector-resolver";
import { normalizeLooseString } from "../../../tools/input-coercion";

export async function handleHighlight(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const wc = ctx.tabManager.getActiveTab()?.view.webContents;
  if (!wc) return "Error: No active tab";
  const selector = await resolveSelector(wc, args.index, args.selector);
  const highlightColor = args.color || "yellow";
  const highlightText = normalizeLooseString(args.text);
  const url = wc.getURL();

  // Persist highlight to database so it survives navigation/reload
  if (url && url !== "about:blank") {
    highlightsManager.addHighlight(
      url,
      typeof selector === "string" ? selector : undefined,
      highlightText,
      typeof args.label === "string" ? args.label : undefined,
      highlightColor,
      "agent",
    );
  }

  return highlightOnPage(
    wc,
    selector,
    highlightText,
    args.label,
    args.durationMs,
    highlightColor,
  );
}

export function handleClearHighlights(ctx: ActionContext): string {
  const wc = ctx.tabManager.getActiveTab()?.view.webContents;
  if (!wc) return "Error: No active tab";
  return clearHighlights(wc);
}
