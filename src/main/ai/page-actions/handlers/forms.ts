import type { ActionContext } from "../core";
import {
  PAGE_SCRIPT_TIMEOUT,
  executePageScript,
  pageBusyError,
  waitForPotentialNavigation,
} from "../core";
import { waitForLoad } from "../../../utils/webcontents-utils";
import { fillFormFields, setElementValue, submitForm } from "../interaction";
import { clickResolvedSelector, searchPage } from "../navigation";

export async function handleFillForm(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const wc = ctx.tabManager.getActiveTab()?.view.webContents;
  if (!wc) return "Error: No active tab";
  const fields = Array.isArray(args.fields) ? args.fields : [];
  if (fields.length === 0) return "Error: No fields provided";
  const fillResults = await fillFormFields(wc, fields);
  const results = fillResults.map((item) => item.result);
  if (args.submit) {
    const firstSel = fillResults.find((item) => item.selector)?.selector ?? null;
    if (firstSel) {
      const beforeUrl = wc.getURL();
      const submitResult = await submitForm(wc, { selector: firstSel });
      await waitForPotentialNavigation(wc, beforeUrl);
      const afterUrl = wc.getURL();
      results.push(afterUrl !== beforeUrl ? `Submitted → ${afterUrl}` : submitResult);
    }
  }
  return `Filled ${results.length} field(s):\n${results.join("\n")}`;
}

export async function handleLogin(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const tab = ctx.tabManager.getActiveTab();
  if (!tab) return "Error: No active tab";
  const wc = tab.view.webContents;
  const steps: string[] = [];

  if (typeof args.url === "string" && args.url.trim()) {
    const id = ctx.tabManager.getActiveTabId()!;
    ctx.tabManager.navigateTab(id, args.url);
    await waitForLoad(wc);
    steps.push(`Navigated to ${wc.getURL()}`);
  }

  const userSel =
    args.username_selector ||
    (await executePageScript<string | null>(
      wc,
      `
      (function() {
        var el = document.querySelector('input[type="email"], input[name="email"], input[name="username"], input[name="user"], input[autocomplete="username"], input[autocomplete="email"], input[type="text"]:not([name="search"]):not([name="q"])');
        return el ? (el.id ? '#' + CSS.escape(el.id) : el.name ? 'input[name="' + el.name + '"]' : null) : null;
      })()
    `,
      { label: "find username field" },
    ));
  if (!userSel)
    return "Error: Could not find username/email field. Try providing username_selector.";

  const passSel =
    args.password_selector ||
    (await executePageScript<string | null>(
      wc,
      `
      (function() {
        var el = document.querySelector('input[type="password"]');
        return el ? (el.id ? '#' + CSS.escape(el.id) : el.name ? 'input[name="' + el.name + '"]' : null) : null;
      })()
    `,
      { label: "find password field" },
    ));
  if (!passSel) return "Error: Could not find password field. Try providing password_selector.";

  const userResult = await setElementValue(wc, userSel, String(args.username || ""));
  steps.push(userResult);
  const passResult = await setElementValue(wc, passSel, String(args.password || ""));
  steps.push(passResult);

  const beforeUrl = wc.getURL();
  if (args.submit_selector) {
    await clickResolvedSelector(wc, String(args.submit_selector));
  } else {
    const clicked = await executePageScript<boolean>(
      wc,
      `
      (function() {
        var btn = document.querySelector('button[type="submit"], input[type="submit"], form button:not([type="button"])');
        if (btn) { btn.click(); return true; }
        var form = document.querySelector('input[type="password"]')?.closest('form');
        if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return true; }
        return false;
      })()
    `,
      { label: "submit login form" },
    );
    if (clicked === PAGE_SCRIPT_TIMEOUT) {
      return pageBusyError("login");
    }
    if (!clicked)
      return (
        steps.join("\n") +
        "\nWarning: Could not find submit button. Credentials filled but form not submitted."
      );
  }

  await waitForPotentialNavigation(wc, beforeUrl);
  const afterUrl = wc.getURL();
  steps.push(afterUrl !== beforeUrl ? `Submitted → ${afterUrl}` : "Form submitted (same page)");
  return `Login flow complete:\n${steps.join("\n")}`;
}

export function handleSearch(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const wc = ctx.tabManager.getActiveTab()?.view.webContents;
  if (!wc) return Promise.resolve("Error: No active tab");
  return searchPage(wc, args);
}

export async function handlePaginate(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const wc = ctx.tabManager.getActiveTab()?.view.webContents;
  if (!wc) return "Error: No active tab";
  const beforeUrl = wc.getURL();

  if (args.selector) {
    return clickResolvedSelector(wc, String(args.selector));
  }

  const isNext = args.direction === "next";
  const clicked = await executePageScript<boolean>(
    wc,
    `
    (function() {
      var patterns = ${
        isNext
          ? '["next", "Next", "›", "»", "→", ">", "Next Page", "Load More"]'
          : '["prev", "Prev", "Previous", "‹", "«", "←", "<", "Previous Page"]'
      };
      var links = document.querySelectorAll('a, button');
      for (var i = 0; i < links.length; i++) {
        var el = links[i];
        var text = (el.textContent || '').trim();
        var ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
        var rel = (el.getAttribute('rel') || '').toLowerCase();
        if (rel === '${isNext ? "next" : "prev"}') { el.click(); return true; }
        for (var j = 0; j < patterns.length; j++) {
          if (text === patterns[j] || ariaLabel.includes(patterns[j].toLowerCase())) {
            el.click();
            return true;
          }
        }
      }
      return false;
    })()
  `,
    { label: "paginate" },
  );
  if (clicked === PAGE_SCRIPT_TIMEOUT) {
    return pageBusyError("paginate");
  }

  if (!clicked)
    return `Error: Could not find ${args.direction} pagination control. Try providing a selector.`;

  await waitForPotentialNavigation(wc, beforeUrl);
  const afterUrl = wc.getURL();
  return afterUrl !== beforeUrl
    ? `Paginated ${args.direction} → ${afterUrl}`
    : `Clicked ${args.direction} (page may have updated dynamically)`;
}
