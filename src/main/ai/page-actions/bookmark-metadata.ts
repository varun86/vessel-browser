import type { Bookmark } from "../../../shared/types";
import { normalizeBookmarkMetadata } from "../../bookmarks/metadata";

/**
 * Extract bookmark metadata from a free-form tool args record.
 * Accepts both camelCase and snake_case field names for cross-model
 * compatibility.
 */
export function getBookmarkMetadataFromArgs(args: Record<string, unknown>): Partial<Bookmark> {
  return normalizeBookmarkMetadata({
    intent: args.intent,
    expectedContent: args.expectedContent ?? args.expected_content,
    keyFields: args.keyFields ?? args.key_fields,
    agentHints: args.agentHints ?? args.agent_hints,
  });
}
