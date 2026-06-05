import assert from "node:assert/strict";
import test from "node:test";

import {
  anthropicCachedSystem,
  anthropicCachedTools,
  buildPromptCacheKey,
  openAIPromptCacheOptions,
} from "../src/main/ai/prompt-cache";

test("OpenAI prompt cache options are only enabled for the direct OpenAI provider", () => {
  const openAIOptions = openAIPromptCacheOptions({
    providerId: "openai",
    model: "gpt-4.1",
    mode: "agent",
    profile: "default",
  });

  assert.equal(openAIOptions.prompt_cache_key, buildPromptCacheKey({
    providerId: "openai",
    model: "gpt-4.1",
    mode: "agent",
    profile: "default",
  }));
  assert.equal(openAIOptions.prompt_cache_retention, "in_memory");
  assert.deepEqual(openAIOptions.stream_options, { include_usage: true });

  assert.deepEqual(
    openAIPromptCacheOptions({
      providerId: "openrouter",
      model: "openai/gpt-4.1",
      mode: "agent",
      profile: "default",
    }),
    {},
  );
});

test("Anthropic cache helpers mark stable system and tool prefixes", () => {
  const system = anthropicCachedSystem("stable instructions");
  assert.deepEqual(system, [
    {
      type: "text",
      text: "stable instructions",
      cache_control: { type: "ephemeral" },
    },
  ]);

  const tools = anthropicCachedTools([
    { name: "first", input_schema: { type: "object" } },
    { name: "second", input_schema: { type: "object" } },
  ]);

  assert.equal(tools[0]?.cache_control, undefined);
  assert.deepEqual(tools[1]?.cache_control, { type: "ephemeral" });
});
