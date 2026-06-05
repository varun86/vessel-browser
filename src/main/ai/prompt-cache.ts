import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import type { ProviderId } from "../../shared/types";
import type { AgentToolProfile } from "./tool-profile";
import { createLogger } from "../../shared/logger";

const logger = createLogger("PromptCache");

export type PromptCacheMode = "chat" | "agent";

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function buildPromptCacheKey(input: {
  providerId: ProviderId;
  model: string;
  mode: PromptCacheMode;
  profile?: AgentToolProfile;
}): string {
  return [
    "vessel",
    input.providerId,
    input.mode,
    input.profile ?? "default",
    shortHash(input.model.trim().toLowerCase()),
  ].join(":");
}

export function openAIPromptCacheOptions(input: {
  providerId: ProviderId;
  model: string;
  mode: PromptCacheMode;
  profile?: AgentToolProfile;
}): Partial<OpenAI.Chat.ChatCompletionCreateParams> {
  if (input.providerId !== "openai") return {};

  return {
    prompt_cache_key: buildPromptCacheKey(input),
    prompt_cache_retention: "in_memory",
    stream_options: { include_usage: true },
  };
}

export function withAnthropicCacheControl<T extends { cache_control?: Anthropic.CacheControlEphemeral | null }>(
  value: T,
): T {
  return {
    ...value,
    cache_control: { type: "ephemeral" },
  };
}

export function anthropicCachedSystem(
  systemPrompt: string,
): Anthropic.TextBlockParam[] {
  return [
    withAnthropicCacheControl({
      type: "text",
      text: systemPrompt,
    }),
  ];
}

export function anthropicCachedTools(
  tools: Anthropic.Tool[],
): Anthropic.Tool[] {
  if (tools.length === 0) return tools;
  return tools.map((tool, index) =>
    index === tools.length - 1 ? withAnthropicCacheControl(tool) : tool,
  );
}

function numericField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function logOpenAIPromptCacheUsage(
  usage: unknown,
  context: { model: string; mode: PromptCacheMode },
): void {
  if (!usage || typeof usage !== "object") return;
  const record = usage as Record<string, unknown>;
  const promptTokens = numericField(record, "prompt_tokens");
  const details = record.prompt_tokens_details;
  const cachedTokens =
    details && typeof details === "object"
      ? numericField(details as Record<string, unknown>, "cached_tokens")
      : null;
  if (promptTokens === null && cachedTokens === null) return;

  logger.debug("OpenAI prompt cache usage", {
    model: context.model,
    mode: context.mode,
    promptTokens,
    cachedTokens,
  });
}

export function logAnthropicPromptCacheUsage(
  usage: unknown,
  context: { model: string; mode: PromptCacheMode },
): void {
  if (!usage || typeof usage !== "object") return;
  const record = usage as Record<string, unknown>;
  const inputTokens = numericField(record, "input_tokens");
  const cacheCreationTokens = numericField(record, "cache_creation_input_tokens");
  const cacheReadTokens = numericField(record, "cache_read_input_tokens");
  if (
    inputTokens === null &&
    cacheCreationTokens === null &&
    cacheReadTokens === null
  ) {
    return;
  }

  logger.debug("Anthropic prompt cache usage", {
    model: context.model,
    mode: context.mode,
    inputTokens,
    cacheCreationTokens,
    cacheReadTokens,
  });
}
