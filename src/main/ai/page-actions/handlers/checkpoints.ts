import type { ActionContext } from "../core";
import { findCheckpoint } from "../navigation";

export function handleCreateCheckpoint(
  ctx: ActionContext,
  args: Record<string, unknown>,
): string {
  const checkpoint = ctx.runtime.createCheckpoint(args.name, args.note);
  return `Created checkpoint ${checkpoint.name} (${checkpoint.id})`;
}

export function handleRestoreCheckpoint(
  ctx: ActionContext,
  args: Record<string, unknown>,
): string {
  const checkpoint = findCheckpoint(
    ctx.runtime.getState().checkpoints,
    args,
  );
  if (!checkpoint) {
    return "Error: No matching checkpoint found";
  }
  ctx.runtime.restoreCheckpoint(checkpoint.id);
  return `Restored checkpoint ${checkpoint.name}`;
}
