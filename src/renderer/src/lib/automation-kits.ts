import type { AutomationKit } from "../../../shared/types";
import { createLogger } from "../../../shared/logger";

const logger = createLogger("AutomationKits");

export const BUNDLED_KITS: AutomationKit[] = [];

/**
 * Render a kit's prompt template by substituting {{key}} placeholders
 * with the values the user filled in.
 */
export function renderKitPrompt(
  kit: AutomationKit,
  values: Record<string, string>,
): string {
  for (const input of kit.inputs) {
    if (input.required && !values[input.key]?.trim()) {
      logger.warn(
        `Required field "${input.key}" is empty for kit "${kit.id}".`,
      );
    }
  }
  return kit.promptTemplate.replace(
    /\{\{(\w+)\}\}/g,
    (_, key: string) => values[key] ?? "",
  );
}
