import type { ActionContext } from "../core";
import { logger } from "../core";
import { sleep } from "../../../utils/webcontents-utils";
import { extractContent } from "../../../content/extractor";
import * as highlightsManager from "../../../highlights/manager";
import {
  captureLiveHighlightSnapshot,
  formatLiveSelectionSection,
} from "../../../highlights/live-snapshot";
import { buildStructuredContext, buildScopedContext } from "../../context-builder";
import { buildCompactScopedContext } from "../../compact-context";
import { chooseCompactReadMode } from "../../compact-listing";
import { MAX_AGENT_DEBUG_CONTENT_LENGTH } from "../../content-limits";
import { tryDismissConsentIframe } from "../overlays";
import {
  fastArticleTextExtract,
  fetchArticleTextExtract,
  glanceExtract,
  normalizeReadPageMode,
} from "../summaries";

export async function handleReadPage(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const wc = ctx.tabManager.getActiveTab()?.view.webContents;
  if (!wc) return "Error: No active tab";

  // Glance mode: ultra-fast viewport scan using textContent (no layout
  // reflow). Shows what a human would see — headings, links, buttons,
  // inputs in the viewport. Ideal for heavy pages where full extraction
  // times out. Always available as an explicit mode, and used as the
  // automatic fallback when full extraction fails.
  const requestedGlance =
    typeof args.mode === "string" && args.mode.trim().toLowerCase() === "glance";

  if (requestedGlance) {
    return glanceExtract(wc);
  }

  const requestedTextMode =
    typeof args.mode === "string"
      ? args.mode.trim().toLowerCase()
      : "";
  if (
    requestedTextMode === "summary" ||
    requestedTextMode === "text_only"
  ) {
    const fastArticleText = await fastArticleTextExtract(
      wc,
      requestedTextMode,
    );
    if (fastArticleText) {
      return fastArticleText;
    }
    const fetchedArticleText = await fetchArticleTextExtract(
      wc,
      requestedTextMode,
    );
    if (fetchedArticleText) {
      return fetchedArticleText;
    }
  }

  // Try full extraction first; if the page JS thread is busy
  // (common on heavy SPAs after navigation), fall back to a
  // lightweight native-only read so the agent isn't blocked.
  let content: Awaited<ReturnType<typeof extractContent>> | null = null;
  try {
    content = await Promise.race([
      extractContent(wc),
      new Promise<null>((resolve) =>
        setTimeout(() => {
          resolve(null);
        }, 6000),
      ),
    ]);
  } catch (err) {
    logger.warn("Failed to extract content for read_page, falling back to lighter recovery:", err);
    content = null;
  }

  // If extraction failed or returned empty content, try a quick iframe
  // consent dismiss (2s budget) then fall through to emergency extraction.
  // We intentionally avoid calling clearOverlays here because it does
  // another full extractContent internally which will also time out on
  // heavy pages, adding 10+ seconds of dead time.
  if (!content || content.content.length === 0) {
    try {
      const iframeResult = await Promise.race([
        tryDismissConsentIframe(wc),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
      ]);
      if (iframeResult) {
        await sleep(500);
        // Quick retry — only 3s budget since we don't want to block long
        try {
          content = await Promise.race([
            extractContent(wc),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
          ]);
        } catch (err) {
          logger.warn("Failed to re-extract content after iframe consent dismissal:", err);
          content = null;
        }
      }
    } catch (err) {
      logger.warn("Failed iframe consent dismissal during read_page recovery:", err);
    }
  }

  if (content && content.content.length > 0) {
    const liveSelectionSection = formatLiveSelectionSection(
      await captureLiveHighlightSnapshot(
        wc,
        highlightsManager.getHighlightsForUrl(content.url),
      ),
    );
    const livePrefix = liveSelectionSection
      ? `${liveSelectionSection}\n\n`
      : "";
    const baseMode = normalizeReadPageMode(args.mode, content);
    const requestedMode =
      ctx.toolProfile === "compact" &&
      (args.mode == null ||
        (typeof args.mode === "string" && !args.mode.trim()))
        ? chooseCompactReadMode(content, baseMode)
        : baseMode;

    if (requestedMode === "debug" || requestedMode === "full") {
      const structured = buildStructuredContext(content);
      const truncated =
        content.content.length > MAX_AGENT_DEBUG_CONTENT_LENGTH
          ? content.content.slice(0, MAX_AGENT_DEBUG_CONTENT_LENGTH) + "\n[Content truncated...]"
          : content.content;
      return `${livePrefix}[read_page mode=debug]\n\n${structured}\n\n## PAGE CONTENT\n\n${truncated}`;
    }

    const scoped =
      ctx.toolProfile === "compact"
        ? buildCompactScopedContext(content, requestedMode)
        : buildScopedContext(content, requestedMode);
    return [
      livePrefix ? livePrefix.trimEnd() : "",
      `[read_page mode=${requestedMode}]`,
      "",
      scoped,
      "",
      `Need more detail? Escalate with read_page(mode="debug") only if the narrow modes are insufficient.`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  // Full extraction failed — fall back to glance mode which uses
  // textContent (no layout reflow) and can work on blocked JS threads
  return glanceExtract(wc);
}
