import crypto from "node:crypto";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { TabGroupColor } from "../../shared/types";
import { createLogger } from "../../shared/logger";
import { errorResult } from "../../shared/result";
import type { AgentRuntime } from "../agent/runtime";
import {
  detectPageType,
  type PageType,
} from "../ai/context-builder";
import { TOOL_DEFINITIONS } from "../tools/definitions";
import { extractContent } from "../content/extractor";
import {
  clickResolvedSelector,
  fillFormFields,
  setElementValue,
  submitFormDirect as submitForm,
} from "../ai/page-actions";
import {
  coerceStringArray,
  normalizeLooseString,
  normalizedOptionalStringSchema,
  stringArrayLikeSchema,
} from "../tools/input-coercion";
import {
  waitForLoad,
  waitForPotentialNavigation,
} from "../utils/webcontents-utils";
import { resolveSelector } from "../utils/selector-resolver";
import type { TabManager } from "../tabs/tab-manager";
import * as highlightsManager from "../highlights/manager";
import { highlightOnPage, clearHighlights } from "../highlights/inject";
import {
  captureLiveHighlightSnapshot,
  formatLiveSelectionSection,
} from "../highlights/live-snapshot";
import { setMcpHealth } from "../health/runtime-health";
import { registerDevTools } from "../devtools/tools";
import { registerBookmarkTools } from "./tools/bookmarks";
import { registerMemoryTools } from "./tools/memory";
import { registerSessionTools } from "./tools/sessions";
import { registerContentTools } from "./tools/content";
import { registerInteractionTools } from "./tools/interaction";
import { registerNavigationTools } from "./tools/navigation";
import * as vaultManager from "../vault/manager";
import { requestConsent } from "../vault/consent";
import { appendAuditEntry } from "../vault/audit";
import * as humanVault from "../vault/human-vault";
import { requestHumanVaultConsent } from "../vault/human-consent";
import { trackVaultAction } from "../telemetry/posthog";
import {
  getPersistentMcpAuthToken,
  writeMcpAuthFile,
  clearMcpAuthFile,
} from "./mcp-auth";
import type { McpServerStartResult } from "./mcp-auth";
import { mcpRuntimeState } from "./mcp-state";
import {
  asTextResponse,
  asErrorTextResponse,
  asNoActiveTabResponse,
  getPremiumToolGateResponse,
  asPromptResponse,
  withAction,
} from "./mcp-helpers";

const logger = createLogger("MCP");
export { getMcpAuthToken, regenerateMcpAuthToken } from "./mcp-auth";
export type { McpServerStartResult } from "./mcp-auth";
export { requiresExplicitMcpApproval } from "./mcp-helpers";
function registerTools(
  server: McpServer,
  tabManager: TabManager,
  runtime: AgentRuntime,
): void {
  server.registerPrompt(
    "vessel-supervisor-brief",
    {
      title: "Vessel Supervisor Brief",
      description:
        "A reusable prompt for reviewing the current Vessel runtime state.",
    },
    async () => {
      const state = runtime.getState();
      const activeTab = getActiveTabSummary(tabManager);
      return asPromptResponse(
        [
          "Review the current Vessel runtime state.",
          `Paused: ${state.supervisor.paused ? "yes" : "no"}`,
          `Approval mode: ${state.supervisor.approvalMode}`,
          `Pending approvals: ${state.supervisor.pendingApprovals.length}`,
          `Open tabs: ${state.session?.tabs.length || 0}`,
          `Human-focused tab: ${activeTab ? `${activeTab.title || "(untitled)"} — ${activeTab.url} [${activeTab.tabId}]` : "none"}`,
          `Recent actions: ${
            state.actions
              .slice(-5)
              .map((action) => action.name)
              .join(", ") || "none"
          }`,
        ].join("\n"),
      );
    },
  );

  server.registerResource(
    "vessel-runtime-state",
    "vessel://runtime/state",
    {
      title: "Vessel Runtime State",
      description:
        "Current supervisor, session, and checkpoint state for the Vessel browser runtime.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "vessel://runtime/state",
          text: JSON.stringify(runtime.getState(), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "vessel-active-tab",
    "vessel://tabs/active",
    {
      title: "Vessel Active Tab",
      description:
        "The tab currently visible to the human user, with URL and title.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "vessel://tabs/active",
          text: JSON.stringify(getActiveTabSummary(tabManager), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "vessel-recommended-tools",
    "vessel://context/recommended-tools",
    {
      title: "Recommended Tools for Current Page",
      description:
        "Context-aware tool recommendations based on the current page type (login, search, form, article, etc.). Returns tools sorted by relevance with contextual hints.",
      mimeType: "application/json",
    },
    async () => {
      const activeTab = tabManager.getActiveTab();
      let pageType: PageType = "GENERAL";
      let pageUrl = "";
      let pageTitle = "";

      if (activeTab) {
        try {
          const wc = activeTab.view.webContents;
          pageUrl = wc.getURL();
          pageTitle = wc.getTitle();
          const page = await extractContent(wc);
          pageType = detectPageType(page);
        } catch (err) {
          logger.warn("Failed to detect page type for tool scoring, falling back to GENERAL:", err);
        }
      }

      // Score and sort tools by relevance for this page type
      const scored = TOOL_DEFINITIONS.map((def) => {
        const tier = def.tier ?? 1;
        const isRelevant = !def.relevance || def.relevance.includes(pageType);
        let score: number;
        if (tier === 0) score = 0;
        else if (tier === 1 && isRelevant) score = 10;
        else if (tier === 2 && isRelevant) score = 20;
        else if (tier === 1) score = 30;
        else score = 40;
        return {
          name: def.name,
          title: def.title,
          description: def.description,
          tier,
          relevance: isRelevant ? "high" : "low",
          score,
        };
      });

      scored.sort((a, b) => a.score - b.score);

      const result = {
        pageType,
        pageUrl,
        pageTitle,
        recommended: scored
          .filter((t) => t.score <= 20)
          .map(({ name, title, description, relevance }) => ({
            name,
            title,
            description,
            relevance,
          })),
        available: scored
          .filter((t) => t.score > 20)
          .map(({ name, title, relevance }) => ({ name, title, relevance })),
      };

      return {
        contents: [
          {
            uri: "vessel://context/recommended-tools",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "list_groups",
    {
      title: "List Tab Groups",
      description:
        "List browser tab groups with names, colors, collapsed state, and member tab count.",
    },
    async () => {
      const groups = tabManager.getGroups();
      const tabs = tabManager.getAllStates();
      if (groups.length === 0) {
        return asTextResponse("No tab groups");
      }
      const lines = groups.map((g) => {
        const count = tabs.filter((t) => t.groupId === g.id).length;
        return `[${g.id}] ${g.name} — color:${g.color} collapsed:${g.collapsed} tabs:${count}`;
      });
      return asTextResponse(lines.join("\n"));
    },
  );

  server.registerTool(
    "create_group",
    {
      title: "Create Tab Group",
      description:
        "Create a new tab group from the active tab or a specified tab. Optionally provide a name and color.",
      inputSchema: {
        tabId: z
          .string()
          .optional()
          .describe("Tab ID to group (defaults to active tab)"),
        name: z.string().optional().describe("Optional group name"),
        color: z
          .enum(["blue", "green", "yellow", "orange", "red", "purple", "gray"])
          .optional()
          .describe("Optional group color"),
      },
    },
    async ({ tabId, name, color }) =>
      withAction(runtime, tabManager, "create_group", { tabId, name, color }, async () => {
        const targetId = tabId || tabManager.getActiveTabId();
        if (!targetId) {
          return "Error: No active tab";
        }
        const groupId = tabManager.createGroupFromTab(targetId, {
          name: name || undefined,
          color: color || undefined,
        });
        if (!groupId) {
          return "Error: Could not create group";
        }
        return `Created group ${groupId}`;
      }),
  );

  server.registerTool(
    "assign_to_group",
    {
      title: "Assign Tab to Group",
      description:
        "Move a tab into an existing group by ID. Defaults to the active tab.",
      inputSchema: {
        groupId: z.string().describe("Group ID to assign the tab to"),
        tabId: z
          .string()
          .optional()
          .describe("Tab ID to move (defaults to active tab)"),
      },
    },
    async ({ groupId, tabId }) =>
      withAction(runtime, tabManager, "assign_to_group", { groupId, tabId }, async () => {
        const targetId = tabId || tabManager.getActiveTabId();
        if (!targetId) {
          return "Error: No active tab";
        }
        tabManager.assignTabToGroup(targetId, groupId);
        return `Assigned tab ${targetId} to group ${groupId}`;
      }),
  );

  server.registerTool(
    "remove_from_group",
    {
      title: "Remove Tab from Group",
      description: "Ungroup a tab. Defaults to the active tab.",
      inputSchema: {
        tabId: z
          .string()
          .optional()
          .describe("Tab ID to ungroup (defaults to active tab)"),
      },
    },
    async ({ tabId }) =>
      withAction(runtime, tabManager, "remove_from_group", { tabId }, async () => {
        const targetId = tabId || tabManager.getActiveTabId();
        if (!targetId) {
          return "Error: No active tab";
        }
        tabManager.removeTabFromGroup(targetId);
        return `Removed tab ${targetId} from group`;
      }),
  );

  server.registerTool(
    "toggle_group",
    {
      title: "Toggle Group Collapsed",
      description: "Collapse or expand a tab group.",
      inputSchema: {
        groupId: z.string().describe("Group ID to toggle"),
      },
    },
    async ({ groupId }) =>
      withAction(runtime, tabManager, "toggle_group", { groupId }, async () => {
        const collapsed = tabManager.toggleGroupCollapsed(groupId);
        if (collapsed === null) {
          return "Error: Group not found";
        }
        return collapsed ? `Collapsed group ${groupId}` : `Expanded group ${groupId}`;
      }),
  );

  server.registerTool(
    "set_group_color",
    {
      title: "Set Group Color",
      description: "Change the color of a tab group.",
      inputSchema: {
        groupId: z.string().describe("Group ID"),
        color: z
          .enum(["blue", "green", "yellow", "orange", "red", "purple", "gray"])
          .describe("New color"),
      },
    },
    async ({ groupId, color }) =>
      withAction(runtime, tabManager, "set_group_color", { groupId, color }, async () => {
        tabManager.setGroupColor(groupId, color as TabGroupColor);
        return `Set group ${groupId} color to ${color}`;
      }),
  );

  server.registerTool(
    "highlight",
    {
      title: "Highlight Element",
      description:
        "Visually highlight an element or text on the page for the user. Use to draw attention to specific parts of the page. Highlights persist until cleared. Set persist=true to save the highlight so it re-appears when the user revisits this page.",
      inputSchema: {
        index: z
          .number()
          .optional()
          .describe("Element index from extracted content to highlight"),
        selector: z
          .string()
          .optional()
          .describe("CSS selector of element to highlight"),
        text: normalizedOptionalStringSchema().describe(
          "Text to find and highlight on the page (highlights all occurrences)",
        ),
        label: z
          .string()
          .optional()
          .describe("Optional annotation label to display near the highlight"),
        durationMs: z
          .number()
          .optional()
          .describe(
            "Auto-clear after this many milliseconds (omit for permanent)",
          ),
        persist: z
          .boolean()
          .optional()
          .describe(
            "If true, save this highlight so it re-appears automatically when the user revisits the page. Ignored when durationMs is set.",
          ),
        color: z
          .enum(["yellow", "red", "green", "blue", "purple", "orange"])
          .optional()
          .describe(
            "Highlight color. Use red for problems/errors, green for targets/success, blue for informational, purple for important, orange for warnings. Defaults to yellow.",
          ),
      },
    },
    async ({ index, selector, text, label, durationMs, persist, color }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      const normalizedText = normalizeLooseString(text);
      return withAction(
        runtime,
        tabManager,
        "highlight",
        {
          index,
          selector,
          text: normalizedText,
          label,
          durationMs,
          persist,
          color,
        },
        async () => {
          const wc = tab.view.webContents;
          const resolvedSelector = await resolveSelector(wc, index, selector);
          const result = await highlightOnPage(
            wc,
            resolvedSelector,
            normalizedText,
            label,
            durationMs,
            color,
          );

          if (
            persist &&
            !durationMs &&
            !result.startsWith("Error") &&
            !result.includes("not found")
          ) {
            const url = highlightsManager.normalizeUrl(wc.getURL());
            highlightsManager.addHighlight(
              url,
              resolvedSelector ?? undefined,
              normalizedText,
              label,
              color,
              "agent",
            );
          }

          return result;
        },
      );
    },
  );

  server.registerTool(
    "clear_highlights",
    {
      title: "Clear Highlights",
      description:
        "Remove all visual highlights from the current page, including any saved persistent highlights for this URL.",
    },
    async () => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "clear_highlights",
        {},
        async () => {
          const wc = tab.view.webContents;
          const url = highlightsManager.normalizeUrl(wc.getURL());
          highlightsManager.clearHighlightsForUrl(url);
          return clearHighlights(wc);
        },
      );
    },
  );

  server.registerTool(
    "list_highlights",
    {
      title: "List Highlights",
      description:
        "List highlights related to the current browsing session. Includes saved persistent highlights plus the active tab's live text selection and any visible unsaved highlight marks. IMPORTANT: When the user says they highlighted or selected text, call this tool before falling back to screenshots or vision.",
      inputSchema: {
        url: z
          .string()
          .optional()
          .describe(
            "URL to list highlights for. Omit to see active tab highlights first, then all others.",
          ),
      },
    },
    async ({ url }) => {
      const state = highlightsManager.getState();
      const activeTab = tabManager.getActiveTab();
      const activeUrl = activeTab
        ? highlightsManager.normalizeUrl(activeTab.view.webContents.getURL())
        : null;
      const activeSavedHighlights = activeUrl
        ? state.highlights.filter((highlight) => highlight.url === activeUrl)
        : [];
      const liveSnapshot =
        activeTab && activeUrl
          ? await captureLiveHighlightSnapshot(
              activeTab.view.webContents,
              activeSavedHighlights,
            )
          : { pageHighlights: [] };
      const unsavedLiveHighlights = liveSnapshot.pageHighlights.filter(
        (highlight) => !highlight.persisted,
      );

      if (url) {
        const filtered = state.highlights.filter(
          (h) => h.url === highlightsManager.normalizeUrl(url),
        );
        const normalizedUrl = highlightsManager.normalizeUrl(url);
        const sections: string[] = [];
        if (activeUrl && activeUrl === normalizedUrl) {
          if (liveSnapshot.activeSelection) {
            sections.push(
              `## Active selection (${activeUrl})\n${JSON.stringify(liveSnapshot.activeSelection, null, 2)}`,
            );
          }
          if (unsavedLiveHighlights.length > 0) {
            sections.push(
              `## Visible unsaved highlights (${activeUrl})\n${JSON.stringify(unsavedLiveHighlights, null, 2)}`,
            );
          }
        }
        if (filtered.length > 0) {
          sections.push(
            `## Saved highlights (${normalizedUrl})\n${JSON.stringify(filtered, null, 2)}`,
          );
        }
        if (sections.length === 0) {
          return asTextResponse(`No highlights or active selection for ${url}`);
        }
        return asTextResponse(sections.join("\n\n"));
      }

      // No URL filter — show active tab's highlights prominently first
      const activeHighlights = activeSavedHighlights;
      const otherHighlights = activeUrl
        ? state.highlights.filter((h) => h.url !== activeUrl)
        : state.highlights;

      const sections: string[] = [];

      if (liveSnapshot.activeSelection) {
        sections.push(
          `## Active selection (${activeUrl})\n${JSON.stringify(liveSnapshot.activeSelection, null, 2)}`,
        );
      }

      if (unsavedLiveHighlights.length > 0) {
        sections.push(
          `## Visible unsaved highlights on active tab (${activeUrl})\n${JSON.stringify(unsavedLiveHighlights, null, 2)}`,
        );
      }

      if (activeHighlights.length > 0) {
        sections.push(
          `## Saved highlights on active tab (${activeUrl})\n${JSON.stringify(activeHighlights, null, 2)}`,
        );
      } else if (activeUrl) {
        sections.push(
          `## Active tab (${activeUrl})\nNo saved highlights on this page.`,
        );
      }

      if (otherHighlights.length > 0) {
        sections.push(
          `## Other saved highlights\n${JSON.stringify(otherHighlights, null, 2)}`,
        );
      }

      if (sections.length === 0) {
        return asTextResponse("No saved or live highlights");
      }

      return asTextResponse(sections.join("\n\n"));
    },
  );

  server.registerTool(
    "remove_highlight",
    {
      title: "Remove Persistent Highlight",
      description:
        "Remove a persistent highlight by ID and clear it from any open tab. Use list_highlights to find IDs.",
      inputSchema: {
        id: z.string().describe("ID of the highlight to remove"),
      },
    },
    async ({ id }) => {
      const removed = highlightsManager.removeHighlight(id);
      if (!removed) {
        return asTextResponse(`No highlight found with id ${id}`);
      }

      // Clear visual highlights and re-apply remaining ones on matching tabs
      const remaining = highlightsManager.getHighlightsForUrl(removed.url);
      for (const tabState of tabManager.getAllStates()) {
        if (highlightsManager.normalizeUrl(tabState.url) !== removed.url) {
          continue;
        }
        const tab = tabManager.getTab(tabState.id);
        if (!tab) continue;
        const wc = tab.view.webContents;
        await clearHighlights(wc);
        for (const h of remaining) {
          if (!h.selector && !h.text) continue;
          void highlightOnPage(
            wc,
            h.selector ?? null,
            h.text,
            h.label,
            undefined,
            h.color,
          ).catch((err) =>
            logger.warn("Failed to restore highlight after removal:", err),
          );
        }
      }

      return asTextResponse(`Removed highlight ${id}`);
    },
  );

  // --- Bookmark tools ---

  registerBookmarkTools(server, tabManager, runtime);

  // --- Session & checkpoint tools ---

  registerContentTools(server, tabManager, runtime);
  registerNavigationTools(server, tabManager, runtime);
  registerInteractionTools(server, tabManager, runtime);
  registerSessionTools(server, tabManager, runtime);

  // --- Memory tools ---
  registerMemoryTools(server, tabManager, runtime);

  // ═══════════════════════════════════════════════════════════════
  // Speedee System — Flow State & Composable Macros
  // ═══════════════════════════════════════════════════════════════

  server.registerTool(
    "flow_start",
    {
      title: "Start Workflow",
      description:
        "Begin tracking a multi-step web workflow. Vessel will show progress after every action so you always know where you are in the flow.",
      inputSchema: {
        goal: z
          .string()
          .describe(
            "What this workflow accomplishes (e.g. 'Purchase item from Amazon')",
          ),
        steps: stringArrayLikeSchema().describe(
          "Ordered list of step labels (e.g. ['Log in', 'Search', 'Select item', 'Checkout'])",
        ),
      },
    },
    async ({ goal, steps }) => {
      const premiumGate = getPremiumToolGateResponse("flow_start");
      if (premiumGate) return premiumGate;

      const normalizedSteps = coerceStringArray(steps) ?? [];
      const tab = tabManager.getActiveTab();
      const flow = runtime.startFlow(
        goal,
        normalizedSteps,
        tab?.view.webContents.getURL(),
      );
      return asTextResponse(
        `Flow started: ${flow.goal}\n${flow.steps.map((s, i) => `  ${i === 0 ? "→" : " "} ${s.label}`).join("\n")}`,
      );
    },
  );

  server.registerTool(
    "flow_advance",
    {
      title: "Advance Workflow Step",
      description:
        "Mark the current workflow step as done and move to the next one. Call this after completing each step.",
      inputSchema: {
        detail: z
          .string()
          .optional()
          .describe("Brief note about what was accomplished"),
      },
    },
    async ({ detail }) => {
      const premiumGate = getPremiumToolGateResponse("flow_advance");
      if (premiumGate) return premiumGate;

      const flow = runtime.advanceFlow(detail);
      if (!flow) return asTextResponse("No active flow to advance");
      const ctx = runtime.getFlowContext();
      return asTextResponse(`Step completed.${ctx}`);
    },
  );

  server.registerTool(
    "flow_status",
    {
      title: "Workflow Status",
      description: "Check the current workflow progress.",
    },
    async () => {
      const premiumGate = getPremiumToolGateResponse("flow_status");
      if (premiumGate) return premiumGate;

      const flow = runtime.getFlowState();
      if (!flow) return asTextResponse("No active workflow.");
      return asTextResponse(runtime.getFlowContext());
    },
  );

  server.registerTool(
    "flow_end",
    {
      title: "End Workflow",
      description: "Clear the active workflow tracker.",
    },
    async () => {
      const premiumGate = getPremiumToolGateResponse("flow_end");
      if (premiumGate) return premiumGate;

      runtime.clearFlow();
      return asTextResponse("Workflow ended.");
    },
  );

  server.registerTool(
    "undo_last_action",
    {
      title: "Undo Last Action",
      description:
        "Undo the most recent agent action by restoring the browser to its state before that action ran. Works for click, type, submit, navigate, and similar mutating actions.",
    },
    async () => {
      const undone = runtime.undoLastAction();
      if (!undone)
        return asTextResponse(
          "Nothing to undo. No undo snapshots available.",
        );
      return asTextResponse(
        `Undid action: ${undone}. Browser restored to state before that action.`,
      );
    },
  );

  // --- Composable Macros ---

  server.registerTool(
    "fill_form",
    {
      title: "Fill Form",
      description:
        "Fill multiple form fields at once. Provide a map of field identifiers to values. Fields are matched by index, name, label, or placeholder. Much faster than calling type for each field individually.",
      inputSchema: {
        fields: z
          .array(
            z.object({
              index: z
                .number()
                .optional()
                .describe("Element index from page content"),
              selector: z.string().optional().describe("CSS selector fallback"),
              name: z
                .string()
                .optional()
                .describe("Field name or id, such as custname"),
              label: z
                .string()
                .optional()
                .describe("Visible label or aria-label text"),
              placeholder: z
                .string()
                .optional()
                .describe("Placeholder text shown in the field"),
              value: z.string().describe("Value to enter"),
            }),
          )
          .describe(
            "Fields to fill, matched by index, selector, name, label, or placeholder",
          ),
        submit: z
          .boolean()
          .optional()
          .describe("Submit the form after filling (default false)"),
      },
    },
    async ({ fields, submit }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "fill_form",
        { fieldCount: fields.length, submit },
        async () => {
          const wc = tab.view.webContents;
          const fillResults = await fillFormFields(wc, fields);
          const results = fillResults.map((item) => item.result);
          if (submit) {
            // Find and submit the form containing the first field
            const firstSel =
              fillResults.find((item) => item.selector)?.selector ?? null;
            if (firstSel) {
              const beforeUrl = wc.getURL();
              const submitResult = await submitForm(wc, undefined, firstSel);
              await waitForPotentialNavigation(wc, beforeUrl);
              const afterUrl = wc.getURL();
              results.push(
                afterUrl !== beforeUrl
                  ? `Submitted → ${afterUrl}`
                  : submitResult,
              );
            }
          }
          return `Filled ${results.length} field(s):\n${results.join("\n")}`;
        },
      );
    },
  );

  server.registerTool(
    "login",
    {
      title: "Login",
      description:
        "Compound action: navigate to a login page, fill credentials, and submit. Handles the full login flow in one call.",
      inputSchema: {
        url: z
          .string()
          .optional()
          .describe("Login page URL (skip if already on login page)"),
        username: z.string().describe("Username or email"),
        password: z.string().describe("Password"),
        username_selector: z
          .string()
          .optional()
          .describe(
            "CSS selector for username field (auto-detected if omitted)",
          ),
        password_selector: z
          .string()
          .optional()
          .describe(
            "CSS selector for password field (auto-detected if omitted)",
          ),
        submit_selector: z
          .string()
          .optional()
          .describe(
            "CSS selector for submit button (auto-detected if omitted)",
          ),
      },
    },
    async ({
      url,
      username,
      password,
      username_selector,
      password_selector,
      submit_selector,
    }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "login",
        { url, username: username.slice(0, 3) + "***" },
        async () => {
          const wc = tab.view.webContents;
          const steps: string[] = [];

          // Step 1: Navigate if URL provided
          if (url) {
            const id = tabManager.getActiveTabId();
            if (!id) return asNoActiveTabResponse();
            tabManager.navigateTab(id, url);
            await waitForLoad(wc);
            steps.push(`Navigated to ${wc.getURL()}`);
          }

          // Step 2: Find form fields
          const userSel =
            username_selector ||
            (await wc.executeJavaScript(`
              (function() {
                var el = document.querySelector('input[type="email"], input[name="email"], input[name="username"], input[name="user"], input[autocomplete="username"], input[autocomplete="email"], input[type="text"]:not([name="search"]):not([name="q"])');
                return el ? (el.id ? '#' + CSS.escape(el.id) : el.name ? 'input[name="' + el.name + '"]' : null) : null;
              })()
            `));
          if (!userSel)
            return "Error: Could not find username/email field. Try providing username_selector.";

          const passSel =
            password_selector ||
            (await wc.executeJavaScript(`
              (function() {
                var el = document.querySelector('input[type="password"]');
                return el ? (el.id ? '#' + CSS.escape(el.id) : el.name ? 'input[name="' + el.name + '"]' : null) : null;
              })()
            `));
          if (!passSel)
            return "Error: Could not find password field. Try providing password_selector.";

          // Step 3: Fill credentials
          const userResult = await setElementValue(wc, userSel, username);
          steps.push(userResult);
          const passResult = await setElementValue(wc, passSel, password);
          steps.push(passResult);

          // Step 4: Submit
          const beforeUrl = wc.getURL();
          if (submit_selector) {
            await clickResolvedSelector(wc, submit_selector);
          } else {
            // Try to find and click a submit button
            const clicked = await wc.executeJavaScript(`
              (function() {
                var btn = document.querySelector('button[type="submit"], input[type="submit"], form button:not([type="button"])');
                if (btn) { btn.click(); return true; }
                var form = document.querySelector('input[type="password"]')?.closest('form');
                if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return true; }
                return false;
              })()
            `);
            if (!clicked)
              return (
                steps.join("\n") +
                "\nWarning: Could not find submit button. Credentials filled but form not submitted."
              );
          }

          await waitForPotentialNavigation(wc, beforeUrl);
          const afterUrl = wc.getURL();
          steps.push(
            afterUrl !== beforeUrl
              ? `Submitted → ${afterUrl}`
              : "Form submitted (same page)",
          );

          return `Login flow complete:\n${steps.join("\n")}`;
        },
      );
    },
  );

  server.registerTool(
    "search",
    {
      title: "Search",
      description:
        "Compound action: find a search box on the current page, type a query, and submit. Returns the resulting page state.",
      inputSchema: {
        query: z.string().describe("Search query text"),
        selector: z
          .string()
          .optional()
          .describe("CSS selector for search input (auto-detected if omitted)"),
      },
    },
    async ({ query, selector }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();

      // Guard: reject queries that look like button/UI labels, not search terms
      const qLower = query.toLowerCase().trim();
      const buttonLabels = [
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
      if (buttonLabels.some((p) => qLower.includes(p))) {
        return asTextResponse(
          `Error: "${query}" looks like a button label, not a search query. Use the click tool to interact with this element instead.`,
        );
      }

      return withAction(runtime, tabManager, "search", { query }, async () => {
        const wc = tab.view.webContents;

        // Find search input
        const searchSel =
          selector ||
          (await wc.executeJavaScript(`
              (function() {
                var el = document.querySelector('input[type="search"], input[name="q"], input[name="query"], input[name="search"], input[role="searchbox"], input[aria-label*="search" i], input[placeholder*="search" i]');
                if (!el) {
                  var inputs = document.querySelectorAll('input[type="text"]');
                  for (var i = 0; i < inputs.length; i++) {
                    var form = inputs[i].closest('form');
                    if (form && (form.getAttribute('role') === 'search' || form.action?.includes('search'))) {
                      el = inputs[i];
                      break;
                    }
                  }
                }
                return el ? (el.id ? '#' + CSS.escape(el.id) : el.name ? 'input[name="' + el.name + '"]' : null) : null;
              })()
            `));
        if (!searchSel)
          return "Error: Could not find search input. Try providing a selector.";

        // Type query
        await setElementValue(wc, searchSel, query);

        // Focus input and press Enter via native Chromium input events
        // (JS dispatchEvent doesn't work on sites like Google that use custom handlers)
        await wc.executeJavaScript(`
            (function() {
              var el = document.querySelector(${JSON.stringify(searchSel)});
              if (el) el.focus();
            })()
          `);
        await new Promise((r) => setTimeout(r, 50));
        const beforeUrl = wc.getURL();
        wc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
        await new Promise((r) => setTimeout(r, 16));
        wc.sendInputEvent({ type: "keyUp", keyCode: "Return" });

        await waitForPotentialNavigation(wc, beforeUrl);
        const afterUrl = wc.getURL();
        return afterUrl !== beforeUrl
          ? `Searched "${query}" → ${afterUrl}`
          : `Searched "${query}" (same page — results may have loaded dynamically)`;
      });
    },
  );

  server.registerTool(
    "paginate",
    {
      title: "Paginate",
      description:
        "Navigate to the next or previous page of results. Auto-detects pagination controls.",
      inputSchema: {
        direction: z.enum(["next", "prev"]).describe("Pagination direction"),
        selector: z
          .string()
          .optional()
          .describe(
            "CSS selector for the pagination link (auto-detected if omitted)",
          ),
      },
    },
    async ({ direction, selector }) => {
      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();
      return withAction(
        runtime,
        tabManager,
        "paginate",
        { direction },
        async () => {
          const wc = tab.view.webContents;
          const beforeUrl = wc.getURL();

          if (selector) {
            return clickResolvedSelector(wc, selector);
          }

          // Auto-detect pagination
          const isNext = direction === "next";
          const clicked = await wc.executeJavaScript(`
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
          `);

          if (!clicked)
            return `Error: Could not find ${direction} pagination control. Try providing a selector.`;

          await waitForPotentialNavigation(wc, beforeUrl);
          const afterUrl = wc.getURL();
          return afterUrl !== beforeUrl
            ? `Paginated ${direction} → ${afterUrl}`
            : `Clicked ${direction} (page may have updated dynamically)`;
        },
      );
    },
  );

  // --- Agent Credential Vault ---
  // These tools implement the "blind fill" pattern: credential values NEVER
  // enter the AI conversation. The agent requests a fill, the main process
  // shows a consent dialog, and fills the form directly via the content script.

  server.registerTool(
    "vault_status",
    {
      title: "Check Vault Credentials",
      description:
        "Check whether stored credentials exist for a domain. Returns credential labels and usernames but NEVER password values. Use this before vault_login to verify credentials are available.",
      inputSchema: {
        domain: z
          .string()
          .describe(
            "The domain to check credentials for (e.g. 'github.com'). If omitted, checks the active tab's domain.",
          )
          .optional(),
      },
    },
    async ({ domain }) => {
      const premiumGate = getPremiumToolGateResponse("vault_status");
      if (premiumGate) return premiumGate;

      let targetDomain = domain;
      if (!targetDomain) {
        const tab = tabManager.getActiveTab();
        if (!tab) return asErrorTextResponse("No active tab and no domain specified");
        try {
          targetDomain = new URL(tab.state.url).hostname;
        } catch (err) {
          logger.warn("Failed to parse active tab URL for vault_status:", err);
          return asErrorTextResponse("Could not parse active tab URL");
        }
      }

      const matches = vaultManager.findEntriesForDomain(
        targetDomain.includes("://") ? targetDomain : `https://${targetDomain}`,
      );

      if (matches.length === 0) {
        return asTextResponse(
          `No stored credentials found for ${targetDomain}. The user needs to add credentials in Settings > Agent Credential Vault before the agent can log in.`,
        );
      }

      appendAuditEntry({
        timestamp: new Date().toISOString(),
        credentialId: matches[0].id,
        credentialLabel: matches[0].label,
        domain: targetDomain,
        action: "status_check",
        approved: true,
      });

      const summary = matches
        .map((m) => `  - "${m.label}" (${m.username})`)
        .join("\n");

      return asTextResponse(
        `Found ${matches.length} credential(s) for ${targetDomain}:\n${summary}\n\nUse vault_login to fill the login form. Credentials are filled directly — you will NOT see the password values.`,
      );
    },
  );

  server.registerTool(
    "vault_login",
    {
      title: "Fill Login with Vault Credentials",
      description:
        "Fill a login form on the current page using stored credentials from the Agent Credential Vault. The credential values are filled directly into the page — they are NEVER returned in this response. The user will see a consent dialog before credentials are used.",
      inputSchema: {
        credential_label: z
          .string()
          .optional()
          .describe(
            "Label of the credential to use. If omitted, uses the first matching credential for the current domain.",
          ),
        username_index: z
          .number()
          .optional()
          .describe(
            "Element index of the username/email input field from read_page.",
          ),
        password_index: z
          .number()
          .optional()
          .describe(
            "Element index of the password input field from read_page.",
          ),
        submit_after: z
          .boolean()
          .optional()
          .describe(
            "Whether to click the submit button after filling credentials. Defaults to false.",
          ),
        submit_index: z
          .number()
          .optional()
          .describe(
            "Element index of the submit button. Required if submit_after is true.",
          ),
      },
    },
    async ({
      credential_label,
      username_index,
      password_index,
      submit_after,
      submit_index,
    }) => {
      const premiumGate = getPremiumToolGateResponse("vault_login");
      if (premiumGate) return premiumGate;

      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();

      const wc = tab.view.webContents;
      let hostname: string;
      try {
        hostname = new URL(tab.state.url).hostname;
      } catch (err) {
        logger.warn("Failed to parse active tab URL for vault_login:", err);
        return asErrorTextResponse("Could not parse active tab URL");
      }

      // Find matching credentials
      const matches = vaultManager.findEntriesForDomain(`https://${hostname}`);
      if (matches.length === 0) {
        return asTextResponse(
          `No stored credentials for ${hostname}. The user needs to add credentials in Settings > Agent Credential Vault.`,
        );
      }

      const match = credential_label
        ? matches.find(
            (m) => m.label.toLowerCase() === credential_label.toLowerCase(),
          )
        : matches[0];

      if (!match) {
        return asTextResponse(
          `No credential named "${credential_label}" found for ${hostname}. Available: ${matches.map((m) => m.label).join(", ")}`,
        );
      }

      // Request user consent
      const consent = await requestConsent({
        credentialLabel: match.label,
        username: match.username,
        domain: hostname,
      });

      appendAuditEntry({
        timestamp: new Date().toISOString(),
        credentialId: match.id,
        credentialLabel: match.label,
        domain: hostname,
        action: "login_fill",
        approved: consent.approved,
      });

      if (!consent.approved) {
        return asTextResponse(
          `User denied credential access for ${hostname}. The agent should not retry without being asked.`,
        );
      }

      // Get raw credentials (NEVER sent to AI — used only for form fill)
      const creds = vaultManager.getCredential(match.id);
      if (!creds) {
        return asErrorTextResponse("Credential not found in vault");
      }

      // Fill username field
      const results: string[] = [];
      if (username_index != null) {
        const usernameResult = await wc.executeJavaScript(
          `window.__vessel?.interactByIndex?.(${username_index}, "value", ${JSON.stringify(creds.username)}) || "Error: interactByIndex not available"`,
        );
        results.push(`Username: ${usernameResult}`);
      }

      // Fill password field
      if (password_index != null) {
        const passwordResult = await wc.executeJavaScript(
          `window.__vessel?.interactByIndex?.(${password_index}, "value", ${JSON.stringify(creds.password)}) || "Error: interactByIndex not available"`,
        );
        results.push(`Password: ${passwordResult.replace(/Typed into:.*/, "Typed into: [password field]")}`);
      }

      // Record usage
      vaultManager.recordUsage(match.id);
      trackVaultAction("login_fill");

      // Optionally submit
      if (submit_after && submit_index != null) {
        const submitResult = await wc.executeJavaScript(
          `window.__vessel?.interactByIndex?.(${submit_index}, "click") || "Error: interactByIndex not available"`,
        );
        results.push(`Submit: ${submitResult}`);
      }

      // Clear credential references from this scope
      // (they exist briefly in memory only during the fill)

      return asTextResponse(
        [
          `Login form filled for ${hostname} using credential "${match.label}".`,
          ...results,
          "",
          "Note: Credential values were filled directly into the page. They are NOT included in this response.",
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "vault_totp",
    {
      title: "Fill TOTP Code from Vault",
      description:
        "Generate a TOTP 2FA code from a stored secret and fill it into a code input field. The TOTP secret and generated code are NEVER returned — only filled directly into the page.",
      inputSchema: {
        credential_label: z
          .string()
          .optional()
          .describe(
            "Label of the credential whose TOTP secret to use. If omitted, uses the first matching credential with a TOTP secret.",
          ),
        code_index: z
          .number()
          .describe(
            "Element index of the TOTP/2FA code input field from read_page.",
          ),
        submit_after: z
          .boolean()
          .optional()
          .describe("Whether to click submit after filling the code."),
        submit_index: z
          .number()
          .optional()
          .describe("Element index of the submit button."),
      },
    },
    async ({ credential_label, code_index, submit_after, submit_index }) => {
      const premiumGate = getPremiumToolGateResponse("vault_totp");
      if (premiumGate) return premiumGate;

      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();

      const wc = tab.view.webContents;
      let hostname: string;
      try {
        hostname = new URL(tab.state.url).hostname;
      } catch (err) {
        logger.warn("Failed to parse active tab URL for vault_totp:", err);
        return asErrorTextResponse("Could not parse active tab URL");
      }

      const matches = vaultManager.findEntriesForDomain(`https://${hostname}`);
      const match = credential_label
        ? matches.find(
            (m) => m.label.toLowerCase() === credential_label.toLowerCase(),
          )
        : matches.find((m) => {
            const secret = vaultManager.getTotpSecret(m.id);
            return secret != null;
          });

      if (!match) {
        return asTextResponse(
          `No credential with TOTP secret found for ${hostname}.`,
        );
      }

      const secret = vaultManager.getTotpSecret(match.id);
      if (!secret) {
        return asTextResponse(
          `Credential "${match.label}" does not have a TOTP secret configured.`,
        );
      }

      // Request user consent
      const consent = await requestConsent({
        credentialLabel: match.label,
        username: match.username,
        domain: hostname,
      });

      appendAuditEntry({
        timestamp: new Date().toISOString(),
        credentialId: match.id,
        credentialLabel: match.label,
        domain: hostname,
        action: "totp_generate",
        approved: consent.approved,
      });

      if (!consent.approved) {
        return asTextResponse(
          `User denied TOTP access for ${hostname}.`,
        );
      }

      // Generate TOTP code (NEVER sent to AI)
      const code = vaultManager.generateTotpCode(secret);

      // Fill the code field
      const fillResult = await wc.executeJavaScript(
        `window.__vessel?.interactByIndex?.(${code_index}, "value", ${JSON.stringify(code)}) || "Error: interactByIndex not available"`,
      );

      vaultManager.recordUsage(match.id);
      trackVaultAction("totp_fill");

      const results = [`2FA code filled: ${fillResult.replace(/Typed into:.*/, "Typed into: [2FA field]")}`];

      if (submit_after && submit_index != null) {
        const submitResult = await wc.executeJavaScript(
          `window.__vessel?.interactByIndex?.(${submit_index}, "click") || "Error: interactByIndex not available"`,
        );
        results.push(`Submit: ${submitResult}`);
      }

      return asTextResponse(
        [
          `TOTP code filled for ${hostname} using credential "${match.label}".`,
          ...results,
          "",
          "Note: The TOTP code was filled directly into the page. It is NOT included in this response.",
        ].join("\n"),
      );
    },
  );

  // --- Human Password Manager ---

  server.registerTool(
    "human_vault_list",
    {
      title: "List Human Passwords",
      description:
        "List saved human passwords for a domain, or all passwords. " +
        "Returns metadata only (never passwords). Use human_vault_fill to fill credentials into a page. " +
        "Requires user consent.",
      inputSchema: z.object({
        domain: z
          .string()
          .optional()
          .describe("Filter by domain (e.g. 'github.com'). Omit for all."),
      }),
    },
    async ({ domain }) => {
      const premiumGate = getPremiumToolGateResponse("human_vault_list");
      if (premiumGate) return premiumGate;

      const consent = await requestHumanVaultConsent({
        action: "list",
        domain: domain ?? "all",
      });
      if (!consent.approved) {
        return asTextResponse("User denied access to password list.");
      }

      humanVault.recordListAccess(domain ?? "all", "mcp_tool");

      const entries = domain
        ? humanVault.findForDomain(domain)
        : humanVault.listEntries();

      if (entries.length === 0) {
        return asTextResponse(
          domain
            ? `No saved passwords for ${domain}.`
            : "No saved passwords.",
        );
      }

      const lines = entries.map((e, i) => {
        const parts = [
          `${i + 1}. "${e.title}"`,
          `   URL: ${e.url}`,
          `   Username: ${e.username || "(none)"}`,
        ];
        if (e.category) parts.push(`   Category: ${e.category}`);
        if (e.tags?.length) parts.push(`   Tags: ${e.tags.join(", ")}`);
        parts.push(
          `   Last used: ${e.lastUsedAt ? new Date(e.lastUsedAt).toLocaleDateString() : "never"}`,
        );
        return parts.join("\n");
      });

      return asTextResponse(
        [
          `Saved passwords${domain ? ` for ${domain}` : ""} (${entries.length}):`,
          "",
          ...lines,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "human_vault_fill",
    {
      title: "Fill Human Password",
      description:
        "Fill saved credentials into the active page's login form. " +
        "Requires user consent. The password is filled directly into the page -- " +
        "it is NEVER included in the response.",
      inputSchema: z.object({
        entry_id: z
          .string()
          .optional()
          .describe("Specific entry ID to fill. Omit to auto-detect by domain."),
        username_index: z
          .number()
          .optional()
          .describe("Element index of the username/email field."),
        password_index: z
          .number()
          .optional()
          .describe("Element index of the password field."),
        submit_after: z
          .boolean()
          .optional()
          .describe("Whether to click submit after filling (default: false)."),
        submit_index: z
          .number()
          .optional()
          .describe("Element index of the submit button (required if submit_after is true)."),
      }),
    },
    async ({ entry_id, username_index, password_index, submit_after, submit_index }) => {
      const premiumGate = getPremiumToolGateResponse("human_vault_fill");
      if (premiumGate) return premiumGate;

      const tab = tabManager.getActiveTab();
      if (!tab) return asNoActiveTabResponse();

      let hostname: string;
      try {
        hostname = new URL(tab.state.url).hostname;
      } catch {
        return asErrorTextResponse("Could not parse active tab URL.");
      }

      // Find the entry
      if (username_index == null && password_index == null) {
        return asErrorTextResponse("Provide at least one field index to fill.");
      }
      if (submit_after && submit_index == null) {
        return asErrorTextResponse("submit_index is required when submit_after is true.");
      }

      let entry;
      if (entry_id) {
        entry = humanVault.getEntry(entry_id);
        if (!entry) {
          return asErrorTextResponse(`No entry found with ID ${entry_id}.`);
        }
        if (!humanVault.entryMatchesUrl(entry.id, `https://${hostname}`)) {
          return asErrorTextResponse(
            `Credential "${entry.title}" is not saved for ${hostname}. Refusing to fill it on this site.`,
          );
        }
      } else {
        const matches = humanVault.findForDomain(`https://${hostname}`);
        if (matches.length === 0) {
          return asTextResponse(
            `No saved passwords for ${hostname}. Add one in Settings > Passwords first.`,
          );
        }
        entry = humanVault.getEntry(matches[0].id);
        if (!entry) {
          return asErrorTextResponse("Matched credential could not be loaded.");
        }
      }

      // Request consent
      const consent = await requestHumanVaultConsent({
        action: "fill",
        entryId: entry.id,
        title: entry.title,
        username: entry.username,
        domain: hostname,
      });
      if (!consent.approved) {
        return asTextResponse("User denied filling credentials.");
      }

      // Decrypt the password (never sent to AI)
      const decrypted = humanVault.getCredential(entry.id);
      if (!decrypted) {
        return asErrorTextResponse("Failed to decrypt password.");
      }

      const wc = tab.view.webContents;
      const results: string[] = [];

      // Fill username
      if (username_index != null) {
        const usernameResult = await wc.executeJavaScript(
          `window.__vessel?.interactByIndex?.(${username_index}, "value", ${JSON.stringify(entry.username)}) || "Error: interactByIndex not available"`,
        );
        results.push(`Username filled: ${usernameResult.replace(/Typed into:.*/, "Typed into: [username field]")}`);
      }

      // Fill password (NEVER included in response text)
      if (password_index != null) {
        const passwordResult = await wc.executeJavaScript(
          `window.__vessel?.interactByIndex?.(${password_index}, "value", ${JSON.stringify(decrypted.password)}) || "Error: interactByIndex not available"`,
        );
        results.push(`Password filled: ${passwordResult.replace(/Typed into:.*/, "Typed into: [password field]")}`);
      }

      // Submit if requested
      if (submit_after && submit_index != null) {
        const submitResult = await wc.executeJavaScript(
          `window.__vessel?.interactByIndex?.(${submit_index}, "click") || "Error: interactByIndex not available"`,
        );
        results.push(`Submit: ${submitResult}`);
      }

      humanVault.recordUsage(entry.id, "mcp_tool");

      return asTextResponse(
        [
          `Credentials filled for ${hostname} using "${entry.title}".`,
          ...results,
          "",
          "Note: The password was filled directly into the page. It is NOT included in this response.",
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "human_vault_remove",
    {
      title: "Remove Human Password",
      description:
        "Delete a saved password. Requires user consent. This cannot be undone.",
      inputSchema: z.object({
        entry_id: z.string().describe("ID of the entry to remove."),
      }),
    },
    async ({ entry_id }) => {
      const premiumGate = getPremiumToolGateResponse("human_vault_remove");
      if (premiumGate) return premiumGate;

      const entry = humanVault.getEntry(entry_id);
      if (!entry) {
        return asErrorTextResponse(`No entry found with ID ${entry_id}.`);
      }

      const consent = await requestHumanVaultConsent({
        action: "remove",
        entryId: entry.id,
        title: entry.title,
      });
      if (!consent.approved) {
        return asTextResponse("User denied removing this password.");
      }

      humanVault.removeEntry(entry_id, "mcp_tool");
      return asTextResponse(`Password "${entry.title}" removed.`);
    },
  );

  // --- Speedee: metrics ---
  server.registerTool(
    "metrics",
    {
      title: "Session Metrics",
      description:
        "Show performance metrics: total tool calls, average duration, per-tool breakdown.",
      inputSchema: z.object({}),
    },
    async () => {
      const premiumGate = getPremiumToolGateResponse("metrics");
      if (premiumGate) return premiumGate;

      const m = runtime.getMetrics();
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
      return asTextResponse(lines.join("\n"));
    },
  );
}

function createMcpServer(
  tabManager: TabManager,
  runtime: AgentRuntime,
): McpServer {
  const server = new McpServer({
    name: "vessel-browser",
    version: "0.1.0",
  });
  registerTools(server, tabManager, runtime);
  registerDevTools(server, tabManager, runtime);
  return server;
}

export function startMcpServer(
  tabManager: TabManager,
  runtime: AgentRuntime,
  port: number,
): Promise<McpServerStartResult> {
  setMcpHealth({
    configuredPort: port,
    activePort: null,
    endpoint: null,
    status: "starting",
    message: `Starting MCP server on port ${port}.`,
  });

  mcpRuntimeState.authToken = getPersistentMcpAuthToken();

  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);

      if (url.pathname !== "/mcp") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      // Only allow CORS from localhost origins (defense-in-depth alongside auth token)
      const origin = req.headers.origin;
      if (
        origin &&
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      ) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader(
          "Access-Control-Allow-Methods",
          "POST, GET, DELETE, OPTIONS",
        );
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, mcp-session-id, Authorization",
        );
      }

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Validate bearer token on all non-OPTIONS requests (constant-time
      // comparison to prevent timing side-channel attacks on persistent tokens).
      const authHeader = req.headers.authorization;
      const expected = `Bearer ${mcpRuntimeState.authToken}`;
      const headerBuf = Buffer.from(authHeader ?? "");
      const expectedBuf = Buffer.from(expected);
      const tokenValid =
        headerBuf.length === expectedBuf.length &&
        crypto.timingSafeEqual(headerBuf, expectedBuf);
      if (!authHeader || !tokenValid) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized — missing or invalid bearer token" }));
        return;
      }

      try {
        const mcpServer = createMcpServer(tabManager, runtime);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);
      } catch (error) {
        logger.error("Error handling request:", error);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : "Unknown error",
            }),
          );
        }
      }
    });

    let settled = false;
    const finish = (result: McpServerStartResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    server.once("error", (error: NodeJS.ErrnoException) => {
      const message =
        error.code === "EADDRINUSE"
          ? `Port ${port} is already in use. MCP server not started.`
          : error.message;
      logger.error("Server error:", error);
      clearMcpAuthFile();
      setMcpHealth({
        configuredPort: port,
        activePort: null,
        endpoint: null,
        status: "error",
        message,
      });
      if (mcpRuntimeState.httpServer === server) {
        mcpRuntimeState.httpServer = null;
      }
      finish(errorResult(message, {
        configuredPort: port,
        activePort: null,
        endpoint: null,
        authToken: null,
      }));
    });

    server.listen(port, "127.0.0.1", () => {
      mcpRuntimeState.httpServer = server;
      const address = server.address();
      const actualPort =
        address && typeof address === "object" ? address.port : port;
      const endpoint = `http://127.0.0.1:${actualPort}/mcp`;
      setMcpHealth({
        configuredPort: port,
        activePort: actualPort,
        endpoint,
        status: "ready",
        message: `MCP server listening on ${endpoint}.`,
      });
      if (process.env.VESSEL_DEBUG_MCP === '1' || process.env.VESSEL_DEBUG_MCP === 'true') {
        logger.info(`Server listening on ${endpoint} (auth enabled)`);
      }
      if (mcpRuntimeState.authToken) {
        writeMcpAuthFile(endpoint, mcpRuntimeState.authToken);
      }
      finish({
        ok: true,
        configuredPort: port,
        activePort: actualPort,
        endpoint,
        authToken: mcpRuntimeState.authToken,
      });
    });
  });
}

export function stopMcpServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!mcpRuntimeState.httpServer) {
      setMcpHealth({
        activePort: null,
        endpoint: null,
        status: "stopped",
        message: "MCP server is stopped.",
      });
      resolve();
      return;
    }

    const server = mcpRuntimeState.httpServer;
    mcpRuntimeState.httpServer = null;
    mcpRuntimeState.authToken = null;
    clearMcpAuthFile();
    server.close(() => {
      setMcpHealth({
        activePort: null,
        endpoint: null,
        status: "stopped",
        message: "MCP server is stopped.",
      });
      if (process.env.VESSEL_DEBUG_MCP === '1' || process.env.VESSEL_DEBUG_MCP === 'true') {
        logger.info("Server stopped");
      }
      resolve();
    });
  });
}
