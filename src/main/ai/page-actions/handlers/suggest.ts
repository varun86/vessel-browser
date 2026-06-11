import type { ActionContext } from "../core";
import { logger } from "../core";
import { extractContent } from "../../../content/extractor";

export async function handleSuggest(
  ctx: ActionContext,
): Promise<string> {
  const wc = ctx.tabManager.getActiveTab()?.view.webContents;
  if (!wc) return "No active tab. Use navigate to open a page.";
  let page;
  try {
    page = await extractContent(wc);
  } catch (err) {
    logger.warn("Failed to extract content for suggest:", err);
    return "Could not read page. Try navigate to a working URL.";
  }

  const suggestions: string[] = [];
  suggestions.push(`Page: ${page.title || "(untitled)"}`);
  suggestions.push(`URL: ${page.url}`);
  suggestions.push("");

  const flowCtx = ctx.runtime.getFlowContext();
  if (flowCtx) {
    suggestions.push(flowCtx);
    suggestions.push("");
  }

  const hasPasswordField = page.forms.some((f) =>
    f.fields.some((el) => el.inputType === "password"),
  );
  const hasSearchInput = page.interactiveElements.some(
    (el) =>
      el.inputType === "search" ||
      el.name === "q" ||
      el.name === "query" ||
      (el.placeholder || "").toLowerCase().includes("search"),
  );
  const formCount = page.forms.length;
  const totalFields = page.forms.reduce(
    (n, f) => n + f.fields.length,
    0,
  );
  const linkCount = page.interactiveElements.filter(
    (el) => el.type === "link",
  ).length;
  const hasPagination = page.interactiveElements.some(
    (el) =>
      (el.text || "").toLowerCase() === "next" ||
      el.text === "›" ||
      el.text === "»",
  );
  const hasOverlays = page.overlays.some((o) => o.blocksInteraction);
  const hasCookieConsent = page.overlays.some(
    (overlay) =>
      overlay.blocksInteraction && overlay.kind === "cookie_consent",
  );

  if (hasOverlays) {
    suggestions.push("BLOCKING OVERLAY detected — dismiss it first:");
    if (hasCookieConsent) {
      suggestions.push("  → accept_cookies for consent banners");
      suggestions.push("  → clear_overlays only if consent handling does not unblock the page");
    } else {
      suggestions.push("  → clear_overlays for stacked modals");
      suggestions.push("  → or dismiss_popup for a single popup");
    }
    suggestions.push("");
  }

  if (hasPasswordField) {
    suggestions.push("LOGIN PAGE detected:");
    suggestions.push(
      "  → login(username, password) — handles the full flow",
    );
    suggestions.push(
      "  → Or fill_form + submit_form for manual control",
    );
  } else if (hasSearchInput && linkCount < 10) {
    suggestions.push("SEARCH PAGE detected:");
    suggestions.push(
      "  → search(query) — finds the box, types, submits",
    );
  } else if (hasSearchInput && linkCount >= 10) {
    suggestions.push("SEARCH RESULTS detected:");
    suggestions.push(
      "  → inspect_element(index) to inspect one result card",
    );
    suggestions.push("  → click on a result link");
    if (hasPagination)
      suggestions.push("  → paginate('next') for more results");
  } else if (formCount > 0) {
    suggestions.push(`FORM detected (${totalFields} fields):`);
    suggestions.push("  → fill_form(fields) — fill all fields at once");
  } else if (hasPagination) {
    suggestions.push("PAGINATED CONTENT:");
    suggestions.push(
      "  → read_page(mode='results_only') to inspect likely results",
    );
    suggestions.push("  → paginate('next') for the next page");
  } else if (
    page.content.length > 3000 &&
    page.interactiveElements.length < 10
  ) {
    suggestions.push("ARTICLE/CONTENT page:");
    suggestions.push("  → read_page(mode='summary') for a fast brief");
    suggestions.push(
      "  → read_page(mode='text_only') for readable text",
    );
    suggestions.push("  → scroll to see more");
  } else {
    suggestions.push("GENERAL PAGE:");
    suggestions.push(
      "  → read_page(mode='visible_only') to inspect active controls",
    );
    suggestions.push("  → click on any element by index");
    suggestions.push("  → navigate to go somewhere new");
  }

  suggestions.push("");
  suggestions.push(
    `Available: ${page.interactiveElements.length} interactive elements, ${formCount} forms, ${linkCount} links`,
  );
  return suggestions.join("\n");
}
