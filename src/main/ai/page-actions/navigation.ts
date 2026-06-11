import type { WebContents } from "electron";
import type { AgentCheckpoint } from "../../../shared/types";
import { selectorHelpersJS } from "../../../shared/dom/selector-helpers-js";
import type { TabManager } from "../../tabs/tab-manager";
import { looksLikeCurrentSiteNameQuery } from "../tool-guardrails";
import { buildHuggingFaceSearchShortcut, type SearchShortcut } from "../search-huggingface";
import {
  buildCommonSearchUrlShortcut,
  buildDefaultEngineShortcut,
  buildSearchShortcut,
  normalizeSearchQuery,
} from "../page-search";
import { getPostSearchSummary } from "./summaries";
import { executePageScript, loadPermittedUrl, PAGE_SCRIPT_TIMEOUT, pageBusyError } from "./core";
import { pressKey, setElementValue } from "./interaction";
import { sleep, waitForPotentialNavigation } from "../../utils/webcontents-utils";

export {
  buildCommonSearchUrlShortcut,
  buildSearchShortcut,
  normalizeSearchQuery,
};

export function getTabByMatch(
  tabManager: TabManager,
  match?: string,
): { id: string; title: string; url: string } | null {
  if (!match) return null;
  const lowered = match.toLowerCase();
  return (
    tabManager
      .getAllStates()
      .find(
        (tab) =>
          tab.title.toLowerCase().includes(lowered) ||
          tab.url.toLowerCase().includes(lowered),
      ) || null
  );
}

export function findCheckpoint(
  checkpoints: AgentCheckpoint[],
  args: Record<string, unknown>,
): AgentCheckpoint | null {
  if (typeof args.checkpointId === "string" && args.checkpointId.trim()) {
    return (
      checkpoints.find((item) => item.id === args.checkpointId.trim()) || null
    );
  }

  if (typeof args.name === "string" && args.name.trim()) {
    const lowered = args.name.trim().toLowerCase();
    return (
      [...checkpoints]
        .reverse()
        .find((item) => item.name.toLowerCase() === lowered) || null
    );
  }

  return null;
}

type SearchTargetInfo = {
  selector: string;
  submitSelector?: string | null;
};

async function locateSearchTarget(
  wc: WebContents,
  explicitSelector?: string,
): Promise<SearchTargetInfo | null | typeof PAGE_SCRIPT_TIMEOUT> {
  if (explicitSelector) {
    return { selector: explicitSelector, submitSelector: null };
  }

  return executePageScript<SearchTargetInfo | null>(
    wc,
    `
      (function() {
        function text(value) {
          return value == null ? "" : String(value).trim();
        }

        function normalize(value) {
          return text(value).toLowerCase();
        }

        function isVisible(el) {
          if (!(el instanceof HTMLElement)) return true;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
            return false;
          }
          if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") {
            return false;
          }
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }

        function inViewport(el) {
          if (!(el instanceof HTMLElement)) return true;
          const rect = el.getBoundingClientRect();
          const vw = window.innerWidth || document.documentElement?.clientWidth || 0;
          const vh = window.innerHeight || document.documentElement?.clientHeight || 0;
          return rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
        }

        ${selectorHelpersJS(["data-testid", "name", "form", "aria-label", "placeholder"])}

        function isDisabled(el) {
          return !!(el && el.hasAttribute && (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true"));
        }

        function nearestSearchScope(input) {
          return input.closest('[role="search"], form, header, nav, [class*="search" i], [id*="search" i]');
        }

        function collectCandidates() {
          const seen = new Set();
          const ordered = [];
          const specific = document.querySelectorAll(
            'input[type="search"], input[name="q"], input[name="query"], input[name="search"], input[role="searchbox"], input[aria-label*="search" i], input[placeholder*="search" i], textarea[name="q"], textarea[name="query"], textarea[name="search"], textarea[role="searchbox"], textarea[aria-label*="search" i], textarea[placeholder*="search" i]'
          );
          specific.forEach((el) => {
            if (!seen.has(el)) {
              seen.add(el);
              ordered.push(el);
            }
          });
          document.querySelectorAll('input[type="text"], input:not([type]), textarea').forEach((el) => {
            if (seen.has(el)) return;
            const scope = nearestSearchScope(el);
            if (!scope) return;
            seen.add(el);
            ordered.push(el);
          });
          return ordered;
        }

        function scoreInput(el) {
          if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return -1;
          if (isDisabled(el) || !isVisible(el)) return -1;
          const isTextarea = el instanceof HTMLTextAreaElement;
          const type = isTextarea ? "text" : normalize(el.getAttribute("type") || el.type);
          if (type && !["search", "text", ""].includes(type)) return -1;

          let score = 0;
          if (inViewport(el)) score += 120;
          const rect = el.getBoundingClientRect();
          score += Math.max(0, 40 - Math.min(40, Math.floor(Math.max(0, rect.top) / 20)));

          const name = normalize(el.name);
          const placeholder = normalize(el.getAttribute("placeholder"));
          const aria = normalize(el.getAttribute("aria-label"));
          if (type === "search") score += 80;
          if (name === "q" || name === "query" || name === "search") score += 70;
          if (placeholder.includes("search")) score += 55;
          if (aria.includes("search")) score += 55;

          const scope = nearestSearchScope(el);
          if (scope) {
            score += 35;
            const scopeRole = normalize(scope.getAttribute && scope.getAttribute("role"));
            const scopeLabel = normalize(
              [
                scope.id,
                scope.className,
                scope.getAttribute && scope.getAttribute("aria-label"),
                scope.getAttribute && scope.getAttribute("action"),
              ].filter(Boolean).join(" ")
            );
            if (scopeRole === "search") score += 35;
            if (scopeLabel.includes("search")) score += 30;
            const tag = normalize(scope.tagName);
            if (tag === "header" || tag === "nav") score += 20;
          }

          return score;
        }

        function pickSearchButton(input) {
          const scopes = [
            input.closest('[role="search"]'),
            input.closest('form'),
            nearestSearchScope(input),
            input.parentElement,
          ].filter(Boolean);
          const seen = new Set();
          let best = null;
          let bestScore = -1;

          for (const scope of scopes) {
            scope.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]').forEach((candidate) => {
              if (seen.has(candidate)) return;
              seen.add(candidate);
              if (!(candidate instanceof HTMLElement)) return;
              if (candidate === input || isDisabled(candidate) || !isVisible(candidate)) return;

              const label = normalize(
                candidate.getAttribute("aria-label") ||
                  candidate.textContent ||
                  candidate.getAttribute("title") ||
                  candidate.getAttribute("value")
              );
              const rect = candidate.getBoundingClientRect();
              const inputRect = input.getBoundingClientRect();
              const closeToInput =
                Math.abs(rect.top - inputRect.top) < 80 &&
                Math.abs(rect.left - inputRect.right) < 260;

              let score = 0;
              if (inViewport(candidate)) score += 40;
              if (closeToInput) score += 35;
              if (label.includes("search") || label.includes("go") || label.includes("submit")) score += 45;
              if (candidate.getAttribute("type") === "submit") score += 20;
              if (candidate.closest('[role="search"]') === input.closest('[role="search"]')) score += 20;
              if (candidate.closest('form') && candidate.closest('form') === input.closest('form')) score += 15;

              if (score > bestScore) {
                best = candidate;
                bestScore = score;
              }
            });
          }

          return bestScore >= 35 ? best : null;
        }

        let bestInput = null;
        let bestScore = -1;
        for (const candidate of collectCandidates()) {
          const score = scoreInput(candidate);
          if (score > bestScore) {
            bestInput = candidate;
            bestScore = score;
          }
        }

        if (!bestInput) return null;
        const selector = selectorFor(bestInput);
        if (!selector) return null;
        const submit = pickSearchButton(bestInput);
        return {
          selector: selector,
          submitSelector: submit ? selectorFor(submit) : null,
        };
      })()
    `,
    {
      timeoutMs: 2200,
      label: "find search input",
    },
  );
}

export async function locateImplicitTextTarget(
  wc: WebContents,
): Promise<string | null | typeof PAGE_SCRIPT_TIMEOUT> {
  return executePageScript<string | null>(
    wc,
    `
      (function() {
        function normalize(value) {
          return value == null ? "" : String(value).trim().toLowerCase();
        }

        function isVisible(el) {
          if (!(el instanceof HTMLElement)) return true;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
          if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }

        function inViewport(el) {
          if (!(el instanceof HTMLElement)) return true;
          const rect = el.getBoundingClientRect();
          const vw = window.innerWidth || document.documentElement?.clientWidth || 0;
          const vh = window.innerHeight || document.documentElement?.clientHeight || 0;
          return rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
        }

        function isFillable(el) {
          if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
          if (el.disabled || el.readOnly || el.getAttribute("aria-disabled") === "true") return false;
          const type = el instanceof HTMLTextAreaElement ? "text" : normalize(el.getAttribute("type") || el.type || "text");
          return ["", "search", "text", "email", "url", "tel", "number", "password"].includes(type);
        }

        function nearestSearchScope(input) {
          return input.closest('[role="search"], form, header, nav, [class*="search" i], [id*="search" i]');
        }

        ${selectorHelpersJS(["data-testid", "name", "form", "aria-label", "placeholder"])}

        const active = document.activeElement;
        if (active && isFillable(active) && isVisible(active) && inViewport(active)) {
          return selectorFor(active);
        }

        const candidates = Array.from(
          document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]), textarea')
        ).filter((el) => isFillable(el) && isVisible(el));

        let best = null;
        let bestScore = -1;
        for (const el of candidates) {
          let score = 0;
          if (inViewport(el)) score += 100;
          const rect = el.getBoundingClientRect();
          score += Math.max(0, 36 - Math.min(36, Math.floor(Math.max(0, rect.top) / 22)));

          const type = el instanceof HTMLTextAreaElement ? "text" : normalize(el.getAttribute("type") || el.type);
          const name = normalize(el.getAttribute("name"));
          const placeholder = normalize(el.getAttribute("placeholder"));
          const aria = normalize(el.getAttribute("aria-label"));
          const role = normalize(el.getAttribute("role"));
          const id = normalize(el.getAttribute("id"));

          if (type === "search") score += 80;
          if (role === "searchbox") score += 70;
          if (name === "q" || name === "query" || name === "search") score += 65;
          if (placeholder.includes("search")) score += 55;
          if (aria.includes("search")) score += 55;
          if (id.includes("search")) score += 35;

          const scope = nearestSearchScope(el);
          if (scope) score += 35;

          if (score > bestScore) {
            best = el;
            bestScore = score;
          }
        }

        return best ? selectorFor(best) : null;
      })()
    `,
    {
      timeoutMs: 2200,
      label: "find implicit text input",
    },
  );
}

export async function searchPageWithClick(
  wc: WebContents,
  args: Record<string, unknown>,
  clickElementBySelector: (wc: WebContents, selector: string) => Promise<string>,
): Promise<string> {
  const query = String(args.query || "");
  if (!query) return "Error: No search query provided.";

  const queryLower = query.toLowerCase().trim();
  const buttonLikePatterns = [
    "add to cart",
    "add to bag",
    "add to basket",
    "buy now",
    "buy it now",
    "purchase",
    "continue shopping",
    "keep shopping",
    "view cart",
    "view bag",
    "view basket",
    "go to cart",
    "go to checkout",
    "checkout",
    "check out",
    "proceed to checkout",
    "place order",
    "submit",
    "subscribe",
    "sign up",
    "sign in",
    "log in",
    "register",
    "continue",
  ];
  if (buttonLikePatterns.some((p) => queryLower.includes(p))) {
    return `Error: "${query}" looks like a button label, not a search query. Use the click tool to interact with this element instead.`;
  }

  if (looksLikeCurrentSiteNameQuery(query, wc.getURL(), wc.getTitle() || "")) {
    return `Error: "${query}" looks like the current site's name, not a product query. You are already on ${wc.getURL()}. Open a section like staff picks/new releases or search for actual book titles, authors, or genres instead.`;
  }

  const runShortcut = async (shortcut: SearchShortcut): Promise<string> => {
    const beforeUrl = wc.getURL();
    await loadPermittedUrl(wc, shortcut.url);
    await waitForPotentialNavigation(wc, beforeUrl, 4000);
    const afterUrl = wc.getURL();
    const applied =
      shortcut.appliedFilters.length > 0
        ? ` (${shortcut.appliedFilters.join(", ")})`
        : "";
    const destination = shortcut.section ? ` ${shortcut.section}` : "";
    return `Searched "${query}" via ${shortcut.source}${destination} shortcut${applied} → ${afterUrl}${await getPostSearchSummary(wc)}`;
  };

  if (typeof args.selector !== "string") {
    const shortcut =
      buildHuggingFaceSearchShortcut(wc.getURL(), query) ??
      buildCommonSearchUrlShortcut(wc.getURL(), query);
    if (shortcut) {
      return runShortcut(shortcut);
    }
  }

  const searchInfo = await locateSearchTarget(
    wc,
    typeof args.selector === "string" ? args.selector : undefined,
  );
  if (searchInfo === PAGE_SCRIPT_TIMEOUT) {
    return pageBusyError("search");
  }
  if (!searchInfo?.selector) {
    if (typeof args.selector !== "string") {
      const fallback = buildDefaultEngineShortcut(query);
      if (fallback) {
        return runShortcut(fallback);
      }
    }
    return "Error: Could not find a visible search input. Try read_page(mode=\"visible_only\") or provide a selector.";
  }

  const fillResult = await setElementValue(wc, searchInfo.selector, query);
  if (fillResult.startsWith("Error:")) {
    return fillResult;
  }
  await sleep(100);

  const beforeUrl = wc.getURL();
  const keyResult = await pressKey(wc, {
    key: "Enter",
    selector: searchInfo.selector,
  });
  if (keyResult.startsWith("Error:")) {
    return keyResult;
  }

  await waitForPotentialNavigation(wc, beforeUrl, 3000);
  let afterUrl = wc.getURL();
  if (afterUrl !== beforeUrl) {
    return `Searched "${query}" → ${afterUrl}${await getPostSearchSummary(wc)}`;
  }

  if (searchInfo.submitSelector) {
    const clickResult = await clickElementBySelector(wc, searchInfo.submitSelector);
    if (!clickResult.startsWith("Error:")) {
      await waitForPotentialNavigation(wc, beforeUrl, 3000);
      afterUrl = wc.getURL();
      if (afterUrl !== beforeUrl) {
        return `Searched "${query}" (via search button) → ${afterUrl}${await getPostSearchSummary(wc)}`;
      }
    }
  }

  return `Searched "${query}" (same page — results may have loaded dynamically)${await getPostSearchSummary(wc)}`;
}
