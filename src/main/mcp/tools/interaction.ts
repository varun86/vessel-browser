import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentRuntime } from "../../agent/runtime";
import type { TabManager } from "../../tabs/tab-manager";
// eslint-disable-next-line no-restricted-syntax -- clickResolvedSelector, clearOverlays, dismissPopup, scrollPage are defined in page-actions.ts itself; not yet extracted to sub-modules
import { clickResolvedSelector, clearOverlays, dismissPopup, scrollPage } from "../../ai/page-actions";
import {
  focusElement,
  hoverElement,
  pressKeyDirect as pressKey,
  selectOptionDirect as selectOption,
  setElementValue,
  submitFormDirect as submitForm,
  typeKeystroke,
} from "../../ai/page-actions/interaction";
import {
  coerceOptionalNumber,
  optionalNumberLikeSchema,
} from "../../tools/input-coercion";
import {
  waitForPotentialNavigation,
} from "../../utils/webcontents-utils";
import { resolveSelector } from "../../utils/selector-resolver";
import {
  asNoActiveTabResponse,
  withAction,
} from "../mcp-helpers";

export function registerInteractionTools(
  server: McpServer,
  tabManager: TabManager,
  runtime: AgentRuntime,
): void {
  server.registerTool(
    "click",
    {
      title: "Click Element",
      description:
        "Click an element on the page by its index number or CSS selector.",
      inputSchema: {
        index: z
          .number()
          .optional()
          .describe("Element index from the page content listing"),
        selector: z.string().optional().describe("CSS selector as fallback"),
      },
    },
    async ({ index, selector }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "click",
        { index, selector },
        async () => {
          const wc = tab.view.webContents;
          const resolvedSelector =
            typeof selector === "string" && selector.trim()
              ? await resolveSelector(wc, undefined, selector)
              : typeof index === "number"
                ? `__vessel_idx:${index}`
                : await resolveSelector(wc, index, selector);
          if (!resolvedSelector) {
            return "Error: No index or selector provided";
          }
          return clickResolvedSelector(wc, resolvedSelector);
        },
      );
    },
  );

  server.registerTool(
    "hover",
    {
      title: "Hover Element",
      description:
        "Move the mouse pointer over an element to trigger hover states, tooltips, or dropdown menus.",
      inputSchema: {
        index: z
          .number()
          .optional()
          .describe("Element index from the page content listing"),
        selector: z.string().optional().describe("CSS selector as fallback"),
      },
    },
    async ({ index, selector }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "hover",
        { index, selector },
        async () => {
          const wc = tab.view.webContents;
          const resolvedSelector = await resolveSelector(wc, index, selector);
          if (!resolvedSelector) {
            return "Error: No index or selector provided";
          }
          return hoverElement(wc, resolvedSelector);
        },
      );
    },
  );

  server.registerTool(
    "focus",
    {
      title: "Focus Element",
      description:
        "Focus an input, button, or interactive element. Useful before pressing keys or to trigger focus-dependent UI.",
      inputSchema: {
        index: z
          .number()
          .optional()
          .describe("Element index from the page content listing"),
        selector: z.string().optional().describe("CSS selector as fallback"),
      },
    },
    async ({ index, selector }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "focus",
        { index, selector },
        async () => {
          const wc = tab.view.webContents;
          const resolvedSelector = await resolveSelector(wc, index, selector);
          if (!resolvedSelector) {
            return "Error: No index or selector provided";
          }
          return focusElement(wc, resolvedSelector);
        },
      );
    },
  );

  server.registerTool(
    "type",
    {
      title: "Type Text",
      description:
        "Type text into an input field or textarea. Clears existing content first.",
      inputSchema: {
        index: z
          .number()
          .optional()
          .describe("Element index from the page content listing"),
        selector: z.string().optional().describe("CSS selector as fallback"),
        text: z.string().describe("The text to type"),
        mode: z
          .enum(["default", "keystroke"])
          .optional()
          .describe(
            '"default" sets value directly and fires input+change events. "keystroke" simulates character-by-character key events for apps that validate on keypress.',
          ),
      },
    },
    async ({ index, selector, text, mode }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "type",
        { index, selector, text, mode },
        async () => {
          const resolvedSelector = await resolveSelector(
            tab.view.webContents,
            index,
            selector,
          );
          if (!resolvedSelector) {
            return "Error: No index or selector provided";
          }
          if (mode === "keystroke") {
            return typeKeystroke(tab.view.webContents, resolvedSelector, text);
          }
          return setElementValue(tab.view.webContents, resolvedSelector, text);
        },
      );
    },
  );

  server.registerTool(
    "type_text",
    {
      title: "Type Text",
      description:
        "Alias for type. Type text into an input field or textarea.",
      inputSchema: {
        index: z
          .number()
          .optional()
          .describe("Element index from the page content listing"),
        selector: z.string().optional().describe("CSS selector as fallback"),
        text: z.string().describe("The text to type"),
        mode: z
          .enum(["default", "keystroke"])
          .optional()
          .describe(
            '"default" sets value directly and fires input+change events. "keystroke" simulates character-by-character key events for apps that validate on keypress.',
          ),
      },
    },
    async ({ index, selector, text, mode }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "type_text",
        { index, selector, text, mode },
        async () => {
          const resolvedSelector = await resolveSelector(
            tab.view.webContents,
            index,
            selector,
          );
          if (!resolvedSelector) {
            return "Error: No index or selector provided";
          }
          if (mode === "keystroke") {
            return typeKeystroke(tab.view.webContents, resolvedSelector, text);
          }
          return setElementValue(tab.view.webContents, resolvedSelector, text);
        },
      );
    },
  );

  server.registerTool(
    "select_option",
    {
      title: "Select Option",
      description: "Select an option in a dropdown by label or value.",
      inputSchema: {
        index: z
          .number()
          .optional()
          .describe("Select element index from extracted content"),
        selector: z.string().optional().describe("CSS selector as fallback"),
        label: z.string().optional().describe("Visible option label"),
        value: z.string().optional().describe("Option value"),
      },
    },
    async ({ index, selector, label, value }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "select_option",
        { index, selector, label, value },
        async () =>
          selectOption(tab.view.webContents, index, selector, label, value),
      );
    },
  );

  server.registerTool(
    "submit_form",
    {
      title: "Submit Form",
      description:
        "Submit a form using a field index, submit button index, form selector, or button selector.",
      inputSchema: {
        index: z
          .number()
          .optional()
          .describe("Index of a form field or submit button"),
        selector: z
          .string()
          .optional()
          .describe("Form or submit button selector"),
      },
    },
    async ({ index, selector }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "submit_form",
        { index, selector },
        async () => submitForm(tab.view.webContents, index, selector),
      );
    },
  );

  server.registerTool(
    "press_key",
    {
      title: "Press Key",
      description:
        "Press a keyboard key, optionally after focusing an element.",
      inputSchema: {
        key: z.string().describe("Keyboard key such as Enter or Escape"),
        index: z.number().optional().describe("Element index to focus first"),
        selector: z.string().optional().describe("CSS selector to focus first"),
      },
    },
    async ({ key, index, selector }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "press_key",
        { key, index, selector },
        async () => {
          const wc = tab.view.webContents;
          const beforeUrl = wc.getURL();
          const result = await pressKey(wc, key, index, selector);
          // Enter can trigger form submission or navigation
          if (key === "Enter") {
            await waitForPotentialNavigation(wc, beforeUrl, 3000);
            const afterUrl = wc.getURL();
            if (afterUrl !== beforeUrl) {
              return `${result} -> ${afterUrl}`;
            }
          }
          return result;
        },
      );
    },
  );

  server.registerTool(
    "scroll",
    {
      title: "Scroll Page",
      description: "Scroll the page up or down.",
      inputSchema: {
        direction: z.enum(["up", "down"]).describe("Scroll direction"),
        amount: optionalNumberLikeSchema().describe(
          "Pixels to scroll (default 500)",
        ),
      },
    },
    async ({ direction, amount }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "scroll",
        { direction, amount },
        async () => {
          const pixels = coerceOptionalNumber(amount) ?? 500;
          const dir = direction === "up" ? -pixels : pixels;
          const result = await scrollPage(tab.view.webContents, dir);
          return `Scrolled ${direction} by ${pixels}px (moved ${Math.abs(result.movedY)}px, now at y=${Math.round(result.afterY)})`;
        },
      );
    },
  );

  server.registerTool(
    "scroll_to_element",
    {
      title: "Scroll To Element",
      description: "Scroll a specific element into view by index or selector.",
      inputSchema: z.object({
        index: z.number().optional().describe("Element index to scroll to"),
        selector: z.string().optional().describe("CSS selector to scroll to"),
        position: z
          .enum(["center", "top", "bottom"])
          .optional()
          .describe("Viewport position (default center)"),
      }),
    },
    async ({ index, selector: rawSelector, position }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "scroll_to_element",
        { index, selector: rawSelector, position },
        async () => {
          const wc = tab.view.webContents;
          const sel =
            rawSelector ||
            (index != null ? await resolveSelector(wc, index) : null);
          if (!sel) return "Error: Provide an index or selector.";
          const block =
            position === "top"
              ? "start"
              : position === "bottom"
                ? "end"
                : "center";

          if (sel.startsWith("__vessel_idx:")) {
            const idx = Number(sel.slice("__vessel_idx:".length));
            return wc.executeJavaScript(`
              (function() {
                var refs = window.__vessel;
                if (!refs || !refs.interactByIndex) return "Error: __vessel not available";
                // Use stored ref directly
                var el = document.querySelector('[data-vessel-idx="${idx}"]');
                if (!el) return "Error: Element #${idx} not found";
                el.scrollIntoView({ behavior: "smooth", block: "${block}" });
                return "Scrolled to element #${idx}";
              })()
            `);
          }

          if (sel.includes(" >>> ")) {
            return wc.executeJavaScript(`
              (function() {
                var el = window.__vessel?.resolveShadowSelector?.(${JSON.stringify(sel)});
                if (!el) return "Error: Shadow DOM element not found";
                el.scrollIntoView({ behavior: "smooth", block: "${block}" });
                return "Scrolled to shadow DOM element";
              })()
            `);
          }

          return wc.executeJavaScript(`
            (function() {
              var el = document.querySelector(${JSON.stringify(sel)});
              if (!el) return "Error: Element not found";
              el.scrollIntoView({ behavior: "smooth", block: "${block}" });
              return "Scrolled to element";
            })()
          `);
        },
      );
    },
  );

  server.registerTool(
    "dismiss_popup",
    {
      title: "Dismiss Popup",
      description:
        "Dismiss a modal, popup, newsletter gate, cookie banner, or blocking overlay using common close and decline actions.",
    },
    async () => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(runtime, tabManager, "dismiss_popup", {}, async () =>
        dismissPopup(tab.view.webContents),
      );
    },
  );

  server.registerTool(
    "clear_overlays",
    {
      title: "Clear Overlays",
      description:
        "Work through blocking overlays and modals until the page is unblocked, using overlay-specific heuristics for consent banners and radio-selection dialogs.",
      inputSchema: {
        strategy: z
          .enum(["auto", "interactive"])
          .optional()
          .describe(
            'How aggressively to clear overlays. "auto" uses heuristics; "interactive" stops earlier when human judgment may be needed.',
          ),
      },
    },
    async ({ strategy }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "clear_overlays",
        { strategy: strategy || "auto" },
        async () =>
          clearOverlays(
            tab.view.webContents,
            strategy === "interactive" ? "interactive" : "auto",
          ),
      );
    },
  );

  server.registerTool(
    "accept_cookies",
    {
      title: "Accept Cookies",
      description:
        "Dismiss cookie consent banners (OneTrust, CookieBot, GDPR popups, etc.).",
      inputSchema: z.object({}),
    },
    async () => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "accept_cookies",
        {},
        async () => {
          const wc = tab.view.webContents;
          const dismissed = await wc.executeJavaScript(`
            (function() {
              var selectors = [
                '#onetrust-accept-btn-handler',
                '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
                '[data-cookiefirst-action="accept"]',
                '.cookie-consent-accept-all',
                '#accept-cookies',
                '.cc-accept',
                '.cc-btn.cc-allow',
                '[aria-label="Accept cookies"]',
                '[aria-label="Accept all cookies"]',
                '[data-testid="cookie-accept"]',
              ];
              var textPatterns = ['accept all', 'accept cookies', 'allow all', 'allow cookies', 'agree', 'got it', 'ok', 'i agree', 'consent'];
              for (var i = 0; i < selectors.length; i++) {
                var el = document.querySelector(selectors[i]);
                if (el && el instanceof HTMLElement) { el.click(); return "Dismissed cookie banner via: " + selectors[i]; }
              }
              var buttons = document.querySelectorAll('button, a[role="button"], [type="submit"]');
              for (var j = 0; j < buttons.length; j++) {
                var btn = buttons[j];
                var text = (btn.textContent || '').trim().toLowerCase();
                for (var k = 0; k < textPatterns.length; k++) {
                  if (text === textPatterns[k] || text.startsWith(textPatterns[k])) {
                    btn.click();
                    return "Dismissed cookie banner via text match: " + text;
                  }
                }
              }
              return null;
            })()
          `);
          return (
            dismissed ||
            "No cookie consent banner detected. Try dismiss_popup for other overlays."
          );
        },
      );
    },
  );
}
