import type {
  ActionSource,
  AgentActionEntry,
  AgentRuntimeState,
} from "../../../shared/types";

const AGENT_ACTIVITY_WINDOW_MS = 6000;
export const AGENT_RUNNING_STALE_WINDOW_MS = 5 * 60_000;

function isAgentActionSource(source: ActionSource): boolean {
  return source === "ai" || source === "mcp";
}

function isAgentActionActive(
  action: AgentActionEntry,
  currentTime: number,
): boolean {
  if (!isAgentActionSource(action.source)) return false;

  if (action.status === "waiting-approval") {
    return true;
  }

  if (action.status === "running") {
    const startedAt = new Date(action.startedAt).getTime();
    if (Number.isNaN(startedAt)) return false;
    return currentTime - startedAt < AGENT_RUNNING_STALE_WINDOW_MS;
  }

  if (action.status !== "completed" || !action.finishedAt) {
    return false;
  }

  const finishedAt = new Date(action.finishedAt).getTime();
  if (Number.isNaN(finishedAt)) return false;

  return currentTime - finishedAt < AGENT_ACTIVITY_WINDOW_MS;
}

export function getAgentActiveTabIds(
  state: AgentRuntimeState,
  currentTime = Date.now(),
): Set<string> {
  const activeTabIds = new Set<string>();

  for (const action of state.actions) {
    if (!action.tabId || !isAgentActionActive(action, currentTime)) {
      continue;
    }

    activeTabIds.add(action.tabId);
  }

  return activeTabIds;
}
