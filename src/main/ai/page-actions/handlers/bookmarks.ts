import type { WebContents } from "electron";
import type { ActionContext } from "../core";
import { handleBookmarkAction } from "../bookmark-actions";
import { getBookmarkMetadataFromArgs } from "../bookmark-metadata";

const BOOKMARK_TOOLS = new Set([
  "list_bookmarks",
  "search_bookmarks",
  "create_bookmark_folder",
  "save_bookmark",
  "organize_bookmark",
  "archive_bookmark",
  "open_bookmark",
]);

export function isBookmarkAction(name: string): boolean {
  return BOOKMARK_TOOLS.has(name);
}

export async function handleBookmarks(
  ctx: ActionContext,
  wc: WebContents | undefined,
  tabId: string | null,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  return handleBookmarkAction({
    name,
    actionArgs: args,
    ctx,
    wc,
    tabId,
    getBookmarkMetadataFromArgs,
  });
}
