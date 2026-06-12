import { ipcMain } from "electron";
import { z } from "zod";
import { Channels } from "../../shared/channels";
import { loadSettings } from "../config/settings";
import { createProvider, fetchProviderModels } from "../ai/provider";
import type { AIProvider } from "../ai/provider";
import { handleAIQuery } from "../ai/commands";
import { endAIStream, onAIStreamIdle, tryBeginAIStream } from "../ai/stream-lock";
import type { AIMessage, ProviderConfig } from "../../shared/types";
import { compactProviderHistory } from "../../shared/ai-history";
import { errorResult, getErrorMessage } from "../../shared/result";
import {
  assertTrustedIpcSender,
  parseIpc,
  type SendToRendererViews,
} from "./common";
import type { AgentRuntime } from "../agent/runtime";
import type { ResearchOrchestrator } from "../agent/research/orchestrator";
import type { TabManager } from "../tabs/tab-manager";

// --- Zod schemas for IPC validation ---

const AIQuerySchema = z.string().min(1);
const AIMessageSchema: z.ZodType<AIMessage> = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

const AIHistorySchema = z.array(AIMessageSchema).optional();

const ReasoningEffortSchema = z.enum(["off", "low", "medium", "high", "max"]);

const ProviderConfigSchema = z.object({
  id: z.enum([
    "anthropic",
    "openai",
    "openai_codex",
    "openrouter",
    "ollama",
    "llama_cpp",
    "mistral",
    "xai",
    "google",
    "custom",
  ]),
  apiKey: z.string(),
  hasApiKey: z.boolean().optional(),
  model: z.string(),
  baseUrl: z.string().optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
}) satisfies z.ZodType<ProviderConfig>;

let activeChatProvider: AIProvider | null = null;
let activeManualStream:
  | {
      cancelled: boolean;
      ended: boolean;
    }
  | null = null;

function finishManualStream(
  run: { cancelled: boolean; ended: boolean },
  sendToRendererViews: SendToRendererViews,
  status: "completed" | "failed",
): void {
  if (run.ended) return;
  run.ended = true;
  sendToRendererViews(Channels.AI_STREAM_END, status);
}

export function registerAIHandlers(
  tabManager: TabManager,
  runtime: AgentRuntime,
  sendToRendererViews: SendToRendererViews,
  getResearchOrchestrator: () => ResearchOrchestrator,
): void {
  onAIStreamIdle(() => {
    sendToRendererViews(Channels.AI_STREAM_IDLE);
  });

  ipcMain.handle(Channels.AI_QUERY, async (event, query: unknown, history?: unknown) => {
    assertTrustedIpcSender(event);
    const validatedQuery = parseIpc(AIQuerySchema, query, "query");
    const validatedHistory = history !== undefined
      ? parseIpc(AIHistorySchema, history, "history")
      : undefined;
    const settings = loadSettings();
    const chatConfig = settings.chatProvider;

    if (!chatConfig) {
      sendToRendererViews(Channels.AI_STREAM_START, validatedQuery);
      sendToRendererViews(
        Channels.AI_STREAM_CHUNK,
        "Chat provider not configured. Open Settings (Ctrl+,) to choose a provider.",
      );
      sendToRendererViews(Channels.AI_STREAM_END, "failed");
      return { accepted: true as const };
    }

    if (!tryBeginAIStream("manual")) {
      return { accepted: false as const, reason: "busy" as const };
    }

    const run = { cancelled: false, ended: false };
    activeManualStream = run;
    sendToRendererViews(Channels.AI_STREAM_START, validatedQuery);

    (async () => {
      let provider: AIProvider | null = null;
      try {
        provider = createProvider(chatConfig);
        activeChatProvider = provider;
        const activeTab = tabManager.getActiveTab();
        await handleAIQuery(
          validatedQuery,
          provider,
          activeTab?.view.webContents,
          (chunk) => {
            if (!run.cancelled && !run.ended) {
              sendToRendererViews(Channels.AI_STREAM_CHUNK, chunk);
            }
          },
          () => {
            if (!run.cancelled) {
              finishManualStream(run, sendToRendererViews, "completed");
            }
          },
          tabManager,
          runtime,
          compactProviderHistory(validatedHistory),
          getResearchOrchestrator(),
        );
      } catch (err: unknown) {
        if (!run.cancelled) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          sendToRendererViews(Channels.AI_STREAM_CHUNK, `\n[Error: ${msg}]`);
          finishManualStream(run, sendToRendererViews, "failed");
        }
      } finally {
        if (activeManualStream === run) activeManualStream = null;
        if (activeChatProvider === provider) activeChatProvider = null;
        endAIStream("manual");
      }
    })();

    return { accepted: true as const };
  });

  ipcMain.handle(Channels.AI_CANCEL, (event) => {
    assertTrustedIpcSender(event);
    if (activeManualStream && !activeManualStream.ended) {
      activeManualStream.cancelled = true;
      finishManualStream(activeManualStream, sendToRendererViews, "failed");
      endAIStream("manual");
    }
    activeChatProvider?.cancel();
  });

  ipcMain.handle(Channels.AI_FETCH_MODELS, async (event, config: unknown) => {
    assertTrustedIpcSender(event);
    try {
      const validatedConfig = parseIpc(ProviderConfigSchema, config, "providerConfig");
      return await fetchProviderModels(validatedConfig);
    } catch (err: unknown) {
      return errorResult(getErrorMessage(err), { models: [] });
    }
  });
}
