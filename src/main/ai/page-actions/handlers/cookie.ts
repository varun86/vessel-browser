import type { ActionContext } from "../core";
import { PAGE_SCRIPT_TIMEOUT, pageBusyError } from "../core";
import { tryAcceptCookiesQuickly } from "../overlays";

export async function handleAcceptCookies(
  ctx: ActionContext,
): Promise<string> {
  const wc = ctx.tabManager.getActiveTab()?.view.webContents;
  if (!wc) return "Error: No active tab";
  const dismissed = await tryAcceptCookiesQuickly(wc);
  if (dismissed === PAGE_SCRIPT_TIMEOUT) {
    return pageBusyError("accept_cookies");
  }
  if (dismissed) return dismissed.message;

  return "No cookie consent banner detected. Try dismiss_popup for other overlays.";
}
