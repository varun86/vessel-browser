import type { ActionContext } from "../core";
import * as namedSessionManager from "../../../sessions/manager";

export async function handleSaveSession(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) return "Error: Session name is required";
  const saved = await namedSessionManager.saveNamedSession(
    ctx.tabManager,
    name,
  );
  return `Saved session "${saved.name}" (${saved.cookieCount} cookies, ${saved.originCount} localStorage origins)`;
}

export async function handleLoadSession(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) return "Error: Session name is required";
  const loaded = await namedSessionManager.loadNamedSession(
    ctx.tabManager,
    name,
  );
  return `Loaded session "${loaded.name}" (${loaded.cookieCount} cookies, ${loaded.originCount} localStorage origins)`;
}

export async function handleListSessions(): Promise<string> {
  const sessions = await namedSessionManager.listNamedSessions();
  if (sessions.length === 0) return "No saved sessions";
  return sessions
    .map(
      (item) =>
        `- ${item.name} | updated=${item.updatedAt} | cookies=${item.cookieCount} | origins=${item.originCount}${item.domains.length ? ` | domains=${item.domains.slice(0, 6).join(", ")}${item.domains.length > 6 ? ", ..." : ""}` : ""}`,
    )
    .join("\n");
}

export async function handleDeleteSession(
  args: Record<string, unknown>,
): Promise<string> {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) return "Error: Session name is required";
  return (await namedSessionManager.deleteNamedSession(name))
    ? `Deleted session "${name}"`
    : `Session "${name}" not found`;
}
